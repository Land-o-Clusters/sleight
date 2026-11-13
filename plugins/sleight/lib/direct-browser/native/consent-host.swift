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
import AVFoundation
import CoreAudio

// BEGIN PERSON INPUT
private var consentFeedbackKey: UInt8 = 0
private var consentArmingKey: UInt8 = 0
// Match the Windows card interval. Compare the input's timestamp, including queued input.
let consentArmingDelay: TimeInterval = 0.5
final class ConsentArming {
    private(set) var presentedAt = Double.infinity
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    init(_ window: NSWindow) {
        func observe(_ center: NotificationCenter, _ name: Notification.Name, object: AnyObject? = nil, activation: Bool = false) {
            let token = center.addObserver(forName: name, object: object, queue: nil) { [weak self, weak window] _ in
                guard let self = self, let window = window, window.isVisible else { return }
                if activation { self.activated(window) } else { self.presented() }
            }
            observers.append((center, token))
        }
        observe(.default, NSWindow.didBecomeKeyNotification, object: window, activation: true)
        observe(.default, NSApplication.willBecomeActiveNotification, activation: true)
        observe(.default, NSApplication.didBecomeActiveNotification, activation: true)
        observe(.default, NSWindow.didChangeOcclusionStateNotification, object: window)
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.activeSpaceDidChangeNotification)
        observe(NSWorkspace.shared.notificationCenter, NSWorkspace.sessionDidBecomeActiveNotification)
        observe(DistributedNotificationCenter.default(), Notification.Name("com.apple.screenIsUnlocked"))
    }
    deinit { for (center, observer) in observers { center.removeObserver(observer) } }
    func presented(at timestamp: Double = ProcessInfo.processInfo.systemUptime) { presentedAt = timestamp }
    private func activated(_ window: NSWindow) {
        if !activationExempts(window) { presented() }
    }
    private func activationExempts(_ window: NSWindow, now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
        var path = "current-event", began: Double?
        if let event = NSApp.currentEvent, [.leftMouseDown, .leftMouseUp].contains(event.type) {
            // Never let an invalid mouse event fall through to the HID fallback or reuse an earlier down.
            if event.type == .leftMouseDown, event.window === window,
                event.timestamp.isFinite, event.timestamp >= 0, event.timestamp <= now,
                now - event.timestamp < 1, personInput(event.cgEvent) {
                began = event.timestamp
            }
        } else {
            // NSAlert activation can carry an app-defined event instead of the activating click.
            path = "hid"
            let age = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .leftMouseDown)
            if age.isFinite, age >= 0, age < 0.1, window.frame.contains(NSEvent.mouseLocation),
                NSWindow.windowNumber(at: NSEvent.mouseLocation, belowWindowWithWindowNumber: 0) == window.windowNumber {
                began = now - age
            }
        }
        // Neither path grants consent. Dispatch still validates the actual down and up independently.
        let exempt = began.map { $0 >= presentedAt + consentArmingDelay } ?? false
        let message = "CONSENT_ACTIVATION path=\(path) exempt=\(exempt)"
        os_log("%{public}@", log: OSLog(subsystem: "com.sleight.consent", category: "input"), type: .info, message)
        FileHandle.standardError.write(Data("sleight consent: \(message)\n".utf8))
        return exempt
    }
    func accepts(_ event: NSEvent) -> Bool { event.timestamp >= presentedAt + consentArmingDelay }
}
func consentArming(_ window: NSWindow) -> ConsentArming {
    if let arming = objc_getAssociatedObject(window, &consentArmingKey) as? ConsentArming { return arming }
    let arming = ConsentArming(window)
    objc_setAssociatedObject(window, &consentArmingKey, arming, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    return arming
}
let consentInputMessage = "This button needs your own click or key press."
let consentTimingMessage = "Too soon: try again."
func refuseConsentInput(_ button: NSButton? = nil, tooSoon: Bool = false) {
    if let button = button, let label = objc_getAssociatedObject(button, &consentFeedbackKey) as? NSTextField {
        label.stringValue = tooSoon ? consentTimingMessage : consentInputMessage
    }
    let reason = tooSoon ? "CONSENT_TOO_SOON" : "PERSON_INPUT_REQUIRED"
    os_log("%{public}@", log: OSLog(subsystem: "com.sleight.consent", category: "input"), type: .error, reason)
    FileHandle.standardError.write(Data("sleight consent refused: \(reason)\n".utf8))
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
private var personSpentByWindow: [Int: Double] = [:]
func personActivation(_ event: NSEvent?, windowMatches: Bool, keyboard: Bool = true,
    highlighted: Bool = true, accessibility: Bool = false, now: Double = ProcessInfo.processInfo.systemUptime,
    windowNumber: Int? = nil, consent: Bool = false) -> Bool {
    guard !accessibility, let event = event, windowMatches,
        event.timestamp.isFinite, event.timestamp >= 0, event.timestamp <= now, now - event.timestamp < 5,
        let cg = event.cgEvent, (consent || cg.getIntegerValueField(.eventSourceUnixProcessID) == 0), personInput(cg) else { return false }
    // Consent retains WindowServer provenance. A repeated key-down can never confirm.
    if consent {
        guard !(event.type == .keyDown && event.isARepeat),
            keyboard || [.leftMouseDown, .leftMouseUp].contains(event.type) else { return false }
    } else {
        guard event.type == .leftMouseUp || keyboard && highlighted && event.type == .keyDown && !event.isARepeat && [36, 49, 76].contains(event.keyCode) else { return false }
    }
    let window = windowNumber ?? event.windowNumber
    guard event.timestamp > (personSpentByWindow[window] ?? -Double.infinity) else { return false }
    personSpentByWindow[window] = event.timestamp
    return true
}
func personActivation(_ event: NSEvent?, in window: NSWindow?, keyboard: Bool = true, highlighted: Bool = true, consent: Bool = false) -> Bool {
    guard let window = window else { return false }
    return personActivation(event, windowMatches: event?.window === window, keyboard: keyboard, highlighted: highlighted, windowNumber: window.windowNumber, consent: consent)
}
func personChoice(_ kind: String, _ choice: String) -> Bool {
    if ["cancel", "decline", "session"].contains(choice) { return false }
    // A debugger's Once is also a consent to debugging. Plain session app approvals remain host-answerable.
    return choice == "always" || ["action", "debugger", "relaunch", "opt-in", "resume", "turbo-off", "handoff"].contains(kind)
}
// NSAlert owns its NSButtons and their private subclasses. Add guarded input overrides to a zero-storage runtime
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
    let mouseSelector = #selector(NSButton.mouseDown(with:))
    let firstSelector = #selector(NSButton.acceptsFirstMouse(for:))
    guard let mouseMethod = class_getInstanceMethod(base, mouseSelector), let mouseTypes = method_getTypeEncoding(mouseMethod),
        let firstMethod = class_getInstanceMethod(base, firstSelector), let firstTypes = method_getTypeEncoding(firstMethod) else {
        imp_removeBlock(implementation); imp_removeBlock(legacyImplementation); objc_disposeClassPair(guarded); return false
    }
    typealias MouseDown = @convention(c) (AnyObject, Selector, NSEvent) -> Void
    let previousMouse = unsafeBitCast(method_getImplementation(mouseMethod), to: MouseDown.self)
    let mouse: @convention(block) (NSButton, NSEvent) -> Void = { sender, event in
        if let action = sender.target as? ConsentInputAction {
            action.trackMouseDown(event) { previousMouse(sender, mouseSelector, event) }
        } else { previousMouse(sender, mouseSelector, event) }
    }
    let first: @convention(block) (NSButton, NSEvent?) -> Bool = { _, _ in true }
    let mouseImplementation = imp_implementationWithBlock(mouse), firstImplementation = imp_implementationWithBlock(first)
    guard class_addMethod(guarded, selector, implementation, types),
        class_addMethod(guarded, legacySelector, legacyImplementation, legacyTypes),
        class_addMethod(guarded, mouseSelector, mouseImplementation, mouseTypes),
        class_addMethod(guarded, firstSelector, firstImplementation, firstTypes) else {
        for imp in [implementation, legacyImplementation, mouseImplementation, firstImplementation] { imp_removeBlock(imp) }
        objc_disposeClassPair(guarded); return false
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
    private var mouseDown: NSEvent?
    init(_ button: NSButton, mouseOnly: Bool = false, currentEvent: @escaping () -> NSEvent? = { NSApp.currentEvent }) {
        self.button = button
        originalTarget = button.target; originalAction = button.action; self.currentEvent = currentEvent; self.mouseOnly = mouseOnly
        super.init()
        if let window = button.window { _ = consentArming(window) }
        // Failure leaves the protected button disabled. It must never fall back to the unguarded action.
        guard refuseAccessibilityPress(button) else { button.isEnabled = false; refuseConsentInput(button); return }
        button.target = self; button.action = #selector(press(_:))
        button.sendAction(on: .leftMouseUp)
    }
    func trackMouseDown(_ event: NSEvent, perform: () -> Void) {
        // AppKit may end tracking without dispatching an action. Refuse a posted down here so
        // a protected button always reports it, even when no mouse-up action follows.
        guard personInput(event.cgEvent) else { refuseConsentInput(button); return }
        mouseDown = event
        defer { mouseDown = nil }
        perform()
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
        guard let event = event, let window = sender.window,
            typed ? event.type == .keyDown : event.type == .leftMouseUp
            else { refuseConsentInput(sender); return false }
        let arming = consentArming(window)
        if !typed {
            guard let down = mouseDown, down.type == .leftMouseDown, down.window === window,
                down.timestamp.isFinite, down.timestamp >= 0, down.timestamp <= event.timestamp,
                ProcessInfo.processInfo.systemUptime - down.timestamp < 5,
                personInput(down.cgEvent) else { refuseConsentInput(sender); return false }
            guard arming.accepts(down) else { refuseConsentInput(sender, tooSoon: true); return false }
        }
        guard arming.accepts(event) else { refuseConsentInput(sender, tooSoon: true); return false }
        guard personActivation(event, in: window, keyboard: typed, consent: true)
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
    private var lastPresentation = Double.infinity
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
    private func refuse(tooSoon: Bool = false) { clear(); refuseConsentInput(entries.values.first?.button, tooSoon: tooSoon) }
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
        if let window = window {
            let presentation = consentArming(window).presentedAt
            if presentation != lastPresentation { clear(); lastPresentation = presentation }
        }
        if typed.isEmpty && (event.keyCode == 36 || event.keyCode == 76) { return }
        let letter = Self.letter(event)
        // Navigation, digits, punctuation and dead keys do not change or refuse a pending word.
        let multipleCharacters = (event.charactersIgnoringModifiers?.count ?? 0) > 1
        guard [36, 76, 48, 51].contains(event.keyCode) || letter != nil || multipleCharacters else { return }
        if let window = window, !consentArming(window).accepts(event) { refuse(tooSoon: true); return }
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
    // NSAlert assigns Return to its first button. Clear protected equivalents after the final layout,
    // preserving button order and therefore the modal response indexes every caller already uses.
    for (button, choice) in zip(alert.buttons, choices) {
        if personChoice(kind, choice) {
            button.keyEquivalent = ""
            if alert.window.defaultButtonCell === button.cell { alert.window.defaultButtonCell = nil }
        } else if choice == "cancel" && button.keyEquivalent.isEmpty { button.keyEquivalent = "\u{1b}" }
    }
    return actions
}
// END PERSON INPUT

// BEGIN GLIDE STOP
struct GlideStopFrame {
    let nonce: String, token: String, phase: String
    var pid: Int32 = 0
    var window: UInt32 = 0
    static func parse(_ data: [String: Any]) -> GlideStopFrame? {
        guard data["hand"] as? String == "glide-stop", let nonce = data["nonce"] as? String,
            nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
            let token = data["token"] as? String, token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
            let phase = data["phase"] as? String else { return nil }
        if phase == "end", Set(data.keys) == ["hand", "nonce", "token", "phase"] {
            return GlideStopFrame(nonce: nonce, token: token, phase: phase)
        }
        func integer(_ raw: Any?, _ max: Double) -> Double? {
            guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 1, n.doubleValue <= max else { return nil }
            return n.doubleValue
        }
        guard phase == "begin", Set(data.keys) == ["hand", "nonce", "token", "phase", "pid", "windowId"],
            let pid = integer(data["pid"], Double(Int32.max)), let window = integer(data["windowId"], Double(UInt32.max)) else { return nil }
        return GlideStopFrame(nonce: nonce, token: token, phase: phase, pid: Int32(pid), window: UInt32(window))
    }
}
// AppKit points, using the consent card's screen-relative anchor. Prefer free
// space, then sleight's own small consent panel at the target display's edge.
func glideStopRect(target: CGRect, screens: [CGRect], size: CGSize = CGSize(width: 204, height: 44)) -> CGRect? {
    guard !target.isEmpty, !target.isInfinite, !target.isNull else { return nil }
    for screen in screens {
        let regions = [screen,
            CGRect(x: screen.minX, y: max(screen.minY, target.maxY + 8), width: screen.width, height: max(0, screen.maxY - target.maxY - 8)),
            CGRect(x: screen.minX, y: screen.minY, width: screen.width, height: max(0, min(screen.maxY, target.minY - 8) - screen.minY)),
            CGRect(x: screen.minX, y: screen.minY, width: max(0, min(screen.maxX, target.minX - 8) - screen.minX), height: screen.height),
            CGRect(x: max(screen.minX, target.maxX + 8), y: screen.minY, width: max(0, screen.maxX - target.maxX - 8), height: screen.height)]
        for area in regions where area.width >= size.width && area.height >= size.height {
            let rect = CGRect(x: area.midX - size.width / 2, y: area.minY + (area.height - size.height) * 0.62,
                width: size.width, height: size.height)
            if screen.contains(rect), !rect.intersects(target.insetBy(dx: -4, dy: -4)) { return rect }
        }
    }
    if let screen = screens.first(where: { $0.intersects(target) && $0.width >= size.width && $0.height >= size.height }) {
        return CGRect(x: screen.maxX - size.width, y: screen.minY, width: size.width, height: size.height)
    }
    return nil
}
// Geometry changes describe control availability, never a person's decision.
// Keeping the poll separate also permits a fake window provider and frame sink.
final class GlideStopTracker {
    private let frame: GlideStopFrame
    private let send: ([String: Any]) -> Void
    private(set) var unavailable = false
    init(_ frame: GlideStopFrame, send: @escaping ([String: Any]) -> Void) { self.frame = frame; self.send = send }
    func refresh(target: CGRect?, screens: [CGRect], place: (CGRect) -> Void) -> Bool {
        guard !unavailable else { return false }
        guard let target = target, let rect = glideStopRect(target: target, screens: screens) else {
            unavailable = true
            send(["hand": "glide-stop", "nonce": frame.nonce, "token": frame.token, "phase": "control-unavailable"])
            return false
        }
        place(rect); return true
    }
}
final class GlideStopPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
class GlideStopButton: NSButton {
    var stop: () -> Void = {}
    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { false }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {
        if action != .press { super.accessibilityPerformAction(action) }
    }
    override func mouseDown(with event: NSEvent) {
        // Stop on the person's down. Waiting for up would let a held click or
        // the takeover guard end the call before this safety control answers.
        guard event.type == .leftMouseDown,
            personActivation(event, in: window, keyboard: false, consent: true) else { return }
        stop()
    }
    override func keyDown(with event: NSEvent) {
        guard [36, 49, 76].contains(event.keyCode), window?.firstResponder === self,
            personActivation(event, in: window, consent: true) else { return }
        stop()
    }
}
final class GlideStopControl {
    private var panel: GlideStopPanel?
    private var timer: Timer?
    private var active: GlideStopFrame?
    private var tracker: GlideStopTracker?
    private let send: ([String: Any]) -> Void
    init(send: @escaping ([String: Any]) -> Void) { self.send = send }
    private func emit(_ phase: String, _ frame: GlideStopFrame) {
        send(["hand": "glide-stop", "nonce": frame.nonce, "token": frame.token, "phase": phase])
    }
    private func target(_ frame: GlideStopFrame) -> CGRect? {
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
            let row = rows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == frame.window &&
                ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == frame.pid }),
            let raw = row[kCGWindowBounds as String] as? [String: Any],
            let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.width > 0, rect.height > 0 else { return nil }
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        return CGRect(x: rect.minX, y: top - rect.maxY, width: rect.width, height: rect.height)
    }
    func close() {
        timer?.invalidate(); timer = nil; active = nil; tracker = nil
        (panel?.contentView?.subviews.first as? GlideStopButton)?.stop = {}
        panel?.orderOut(nil); panel?.close(); panel = nil
    }
    private func stopped() {
        guard let frame = active else { return }
        close(); emit("stop", frame)
    }
    func receive(_ frame: GlideStopFrame) {
        if frame.phase == "end" { if active?.token == frame.token { close() }; return }
        guard active == nil, let target = target(frame),
            let rect = glideStopRect(target: target, screens: NSScreen.screens.map { $0.visibleFrame }) else { emit("control-unavailable", frame); return }
        let panel = GlideStopPanel(contentRect: rect, styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "sleight"; panel.titleVisibility = .hidden; panel.titlebarAppearsTransparent = true
        panel.level = .floating; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]
        panel.animationBehavior = .none; panel.sharingType = .none; panel.becomesKeyOnlyIfNeeded = true
        let button = GlideStopButton(title: "Stop the Glide engine", target: nil, action: nil)
        button.bezelStyle = .rounded; button.keyEquivalent = ""
        button.frame = NSRect(x: 8, y: 6, width: rect.width - 16, height: rect.height - 12)
        button.stop = { [weak self] in self?.stopped() }
        panel.contentView?.addSubview(button)
        panel.setFrame(rect, display: false)
        self.panel = panel; active = frame
        tracker = GlideStopTracker(frame, send: send)
        panel.orderFrontRegardless(); emit("ready", frame)
        timer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { [weak self] _ in
            guard let self = self, let active = self.active, let panel = self.panel else { return }
            guard self.tracker?.refresh(target: self.target(active), screens: NSScreen.screens.map { $0.visibleFrame }, place: { rect in
                if panel.frame != rect { panel.setFrame(rect, display: false) }
            }) == true else { self.close(); return }
        }
    }
}
func writeGlideStop(_ message: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: message) { FileHandle.standardOutput.write(bytes + Data([10])) }
}
// END GLIDE STOP

// BEGIN PERSON CONFIRM
// High-stakes settings changes (person-confirm.mjs names them) wait for macOS's own Touch ID or
// password sheet, which an agent can't answer: it has no finger, and the password sheet is the system's, which sleight's
// tools refuse to drive (own-host.mjs). The sheet's reason comes only from this table: a key, and at most a bundle id or one
// of the browser names below. On macOS it reads "consent-host is trying to <reason>."
let personConfirmReasons: [String: (plain: String, subject: String?)] = [
    "owner-present-sitting": ("start a hands-off input check on this Mac", nil),
    "turbo-on": ("turn on sleight turbo", "turn on sleight turbo for %@"),
    "turbo-app-on": ("let sleight turbo drive an app", "let sleight turbo drive %@"),
    "permissions-unblock": ("lift one of sleight's blocks", "let sleight act in %@ again"),
    "permissions-unblock-site": ("lift one of sleight's site blocks", "let sleight act on %@ again"),
    "permissions-sites-only": ("limit the sites sleight may act on", "limit sleight to %@ sites"),
    "permissions-sites-all": ("lift the limit to chosen sites; blocked sites stay blocked", nil),
    "permissions-repair": ("repair sleight's permissions file", nil),
    "permissions-repair-discard": ("erase every sleight block and site limit", nil),
    "routine-add": ("install a sleight routine", nil),
    "routine-unlock": ("clear a sleight routine's run lock", nil),
    "watch-add": ("install a sleight watch", nil),
    "watch-unlock": ("clear a sleight watch's run lock", nil),
    "replay": ("run a saved script", nil),
    "record": ("record or convert a run", nil),
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
    let key = arguments[0]
    if key == "permissions-sites-only" || key == "permissions-unblock-site" {
        guard arguments.count == 2, let template = entry.subject else { return nil }
        let value = arguments[1]
        if key == "permissions-sites-only" {
            guard value.range(of: #"^[1-9][0-9]{0,2}$"#, options: .regularExpression) != nil,
                let count = Int(value), count <= 256 else { return nil }
        } else {
            guard value.count <= 2048,
                value.range(of: #"^https?://(?:[a-z0-9*.-]+|\[[a-f0-9:.]+\])(?::[0-9]{1,5})?$"#, options: .regularExpression) != nil,
                value.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        }
        return template.replacingOccurrences(of: "%@", with: value)
    }
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

#if SLEIGHT_SEALED_SETTINGS
// All authorization is produced here. No argument or pipe field claims that a person confirmed.
private var settingsIntentCard: AskCardPanel?
private var settingsIntentSignals: [DispatchSourceSignal] = []
func settingsAuthorizedIntentMain(_ store: SealedSettings, _ arguments: [String]) -> Int32 {
    func finish(_ action: () throws -> Void) -> Never {
        do { try action(); for row in try store.verifyAll() { print(try row.line()) }; exit(0) }
        catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(65) }
    }
    func sheet(_ reason: String, action: @escaping () throws -> Void) -> Never {
        let cancel = confirmPerson(reason, evaluator: localAuthentication()) { result in
            guard result == .confirmed else { exit(result.rawValue) }; finish(action)
        }
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { cancel() }; source.resume(); settingsIntentSignals.append(source)
        }
        dispatchMain()
    }
    do {
        if arguments == ["adopt"] || arguments == ["repair"] || arguments == ["permissions", "repair"] {
            guard isatty(STDIN_FILENO) == 1 && isatty(STDOUT_FILENO) == 1 else { throw SettingsFault.person }
            let review = try store.reviewAdoption()
            FileHandle.standardOutput.write(Data((review.text + "\nGrants are not adopted. Rename preapproved.json and electron-grants.json yourself, then allow each app again.\nType adopt to review these settings with Touch ID: ").utf8))
            guard readLine() == "adopt" else { throw SettingsFault.person }
            let repair = arguments == ["repair"]
            sheet("adopt sleight settings written before sealing") { try store.adoptReviewed(review, word: "adopt", confirmed: true, repair: repair) }
        }
        let change = try store.prepareIntent(arguments)
        if let name = change.cardApp, let risk = change.risk {
            let application = NSApplication.shared
            application.setActivationPolicy(.accessory)
            let card = AskCard(question: "Always allow sleight in " + name + "?", detail: "Risk level: " + risk,
                host: "sleight", icon: consentIconPath(), kind: "opt-in", choices: ["cancel", "always"])
            settingsIntentCard = AskCardPanel(card, deadline: (Date().timeIntervalSince1970 + 60) * 1000) { choice in
                guard choice == "always" else { exit(2) }
                // The protected Always button and typed-word path are the only callers of this closure.
                finish { try store.commitIntent(change, personConfirmed: true) }
            }
            settingsIntentCard!.show(); application.run(); return 2
        }
        if change.needsSheet { sheet(change.reason) { try store.commitIntent(change, personConfirmed: true) } }
        finish { try store.commitIntent(change, personConfirmed: false) }
    } catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); return 65 }
}
#endif

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
struct PermissionsData: Equatable { let grants: [PermissionGrant], current: PermissionApp?, blocked: [String], only: [String]?; var problems: [String] = [] }
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
    guard let data = value as? [String: Any], Set(data.keys).isSubset(of: ["grants", "current", "blocked", "only", "problems"]),
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
    var problems: [String] = []
    if let raw = data["problems"] {
        guard let list = raw as? [Any], list.count <= 3 else { return nil }
        problems = list.compactMap { permissionText($0, 200) }
        guard problems.count == list.count else { return nil }
    }
    return PermissionsData(grants: grants, current: current, blocked: blocked, only: only, problems: problems)
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
    rows += data.problems.map { .info($0) }
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
        consentArming(panel).presented()
        NSSound(named: "Glass")?.play()
    }
    func review() {
        if passive { panel.orderFrontRegardless() } else { panel.makeKeyAndOrderFront(nil) }
        consentArming(panel).presented()
    }
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
// A hand fault may leave the shared consent process alive, so process exit alone cannot detect control loss.
func writeHandControlGone() {
    guard let nonce = nonceBook.nonce("hand"), let bytes = try? JSONSerialization.data(withJSONObject: ["hand": "control-gone", "nonce": nonce]) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func handControlExit(_ frame: [String: Any], nonce: String?) -> Bool {
    guard let nonce = nonce else { return false }
    return Set(frame.keys) == ["hand", "nonce"] && frame["hand"] as? String == "control-exit" && frame["nonce"] as? String == nonce
}
// Pause requests are prepared, committed, then confirmed on the hand's nonce-bound channel.
// A missed acknowledgment leaves the displayed state unchanged and exposes a retry mark.
final class CursorPauseControl {
    private(set) var paused = false, failed = false
    private(set) var pending: (token: String, value: Bool, before: Bool, deadline: Double)?
    private var applied: (token: String, before: Bool)?
    var changed: ((Bool) -> Void)?
    var nonce: () -> String? = { nonceBook.nonce("hand") }
    var now: () -> Double = { ProcessInfo.processInfo.systemUptime }
    var send: ([String: Any]) -> Bool = { frame in
        guard let data = try? JSONSerialization.data(withJSONObject: frame, options: [.sortedKeys]) else { return false }
        do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])); return true } catch { return false }
    }
    var schedule: (Double, @escaping () -> Void) -> Void = { delay, task in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: task) }
    func set(_ value: Bool) { paused = value; changed?(value) }
    func emit(_ phase: String, _ token: String, _ value: Bool) -> Bool {
        guard let nonce = nonce() else { return false }
        return send(["hand": "pause", "nonce": nonce, "paused": value, "token": token, "phase": phase])
    }
    @discardableResult func click(_ event: NSEvent?, windowMatches: Bool, highlighted: Bool = true, accessibility: Bool = false) -> Bool {
        guard pending == nil,
            personActivation(event, windowMatches: windowMatches, highlighted: highlighted, accessibility: accessibility, now: now()) else { return false }
        return request(!paused)
    }
    // Internal continuation of a hardware-authenticated badge drag, never a consent action.
    @discardableResult func request(_ value: Bool) -> Bool {
        guard pending == nil, value != paused else { return false }
        applied = nil
        guard nonce() != nil else { failed = true; changed?(paused); return false }
        let token = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
        pending = (token, value, paused, now() + 0.5); failed = false
        guard emit("request", token, value) else { pending = nil; failed = true; changed?(paused); return false }
        schedule(0.5) { [weak self] in if self?.pending?.token == token { self?.expire() } }
        return true
    }
    func expire() {
        guard let request = pending else { return }
        pending = nil; failed = true
        _ = emit("cancel", request.token, request.value)
        set(request.before)
    }
    func receive(_ phase: String, token: String, value: Bool) {
        if phase == "restore" { pending = nil; applied = nil; failed = false; set(value); _ = emit("restored", token, value); return }
        if phase == "aborted", let previous = applied, previous.token == token {
            applied = nil; pending = nil; failed = true; set(previous.before); return
        }
        guard let request = pending, request.token == token, request.value == value else { return }
        guard now() < request.deadline else { expire(); return }
        if phase == "ready" { _ = emit("commit", token, value) }
        else if phase == "applied" {
            guard emit("confirm", token, value) else { expire(); return }
            applied = (token, request.before); pending = nil; failed = false; set(value)
        } else if phase == "aborted" { pending = nil; failed = true; set(request.before) }
    }
}
final class CursorPauseMenuItem: NSMenuItem {
    var refused: (() -> Void)?
    override func accessibilityPerformPress() -> Bool { refused?(); return false }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) { if action == .press { refused?() } else { super.accessibilityPerformAction(action) } }
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

let channelValidationOnly = CommandLine.arguments.dropFirst().first == "--channels-selftest"

// BEGIN MENU INSTANCE
// A session never waits for menu ownership. Sessions share their own presence file; the standalone menu checks it and
// yields. Keep lock inodes after release so hosts cannot accidentally acquire separate banks.
final class MenuInstance {
    private var descriptor: Int32 = -1
    private var snapshot = stat()
    private var heldPath = ""
    private var reported = Set<String>()
    private(set) var reason: String?
    private func note(_ value: String, standalone: Bool) -> Bool {
        reason = value
        if reported.insert(value).inserted {
            FileHandle.standardError.write(Data("sleight menu: \(value); \(standalone ? "standalone yields" : "session keeps its menu")\n".utf8))
        }
        return !standalone
    }
    private func valid(_ info: stat) -> Bool {
        info.st_uid == getuid() && info.st_nlink == 1 && info.st_mode & S_IFMT == S_IFREG && info.st_mode & 0o7777 == 0o600
    }
    private func same(_ a: stat, _ b: stat) -> Bool {
        a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size && a.st_mode == b.st_mode &&
            a.st_uid == b.st_uid && a.st_nlink == b.st_nlink && a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
            a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec && a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec && a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec
    }
    private func openLock(_ path: String) -> Int32 {
        var fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK, mode_t(0o600))
        if fd < 0 && errno == EEXIST { fd = open(path, O_RDWR | O_NOFOLLOW_ANY | O_CLOEXEC | O_NONBLOCK) }
        guard fd >= 0 else { return -1 }
        var info = stat(), named = stat()
        guard fstat(fd, &info) == 0, lstat(path, &named) == 0, valid(info), same(info, named) else { close(fd); return -1 }
        return fd
    }
    func claim(_ path: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/sleight/menu-presence.lock").path, standalone: Bool = true) -> Bool {
        reason = nil
        let folder = (path as NSString).deletingLastPathComponent
        if mkdir(folder, mode_t(0o700)) != 0 && errno != EEXIST { return note("unavailable-directory", standalone: standalone) }
        let dir = open(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard dir >= 0 else { return note("unsafe-directory", standalone: standalone) }
        defer { close(dir) }
        var directory = stat()
        guard fstat(dir, &directory) == 0, directory.st_uid == getuid(), directory.st_mode & S_IFMT == S_IFDIR,
            directory.st_mode & 0o7777 == 0o700 else { return note("unsafe-directory", standalone: standalone) }
        if descriptor >= 0 {
            var current = stat(), named = stat()
            guard fstat(descriptor, &current) == 0, lstat(heldPath, &named) == 0, valid(current), same(snapshot, current), same(current, named) else {
                release(); return note("changed-lock", standalone: standalone)
            }
            if !standalone { return true }
        }
        let sessionPath = folder + "/menu-session.lock"
        if standalone {
            let session = openLock(sessionPath)
            guard session >= 0 else { return note("unsafe-lock", standalone: true) }
            let free = flock(session, LOCK_EX | LOCK_NB) == 0
            let code = errno
            close(session)
            if !free { return note(code == EWOULDBLOCK ? "session-present" : "unavailable-lock", standalone: true) }
            if descriptor >= 0 { return true }
        }
        let lockPath = standalone ? path : sessionPath
        let fd = openLock(lockPath)
        guard fd >= 0 else { return note("unsafe-lock", standalone: standalone) }
        guard flock(fd, (standalone ? LOCK_EX : LOCK_SH) | LOCK_NB) == 0 else {
            let held = errno == EWOULDBLOCK; close(fd)
            return note(held ? "held-lock" : "unavailable-lock", standalone: standalone)
        }
        var info = stat()
        guard fstat(fd, &info) == 0 else { close(fd); return note("unavailable-lock", standalone: standalone) }
        descriptor = fd; snapshot = info; heldPath = lockPath; return true
    }
    func release() { if descriptor >= 0 { close(descriptor); descriptor = -1 } }
    deinit { release() }
}
// END MENU INSTANCE
func writeMenuReady(_ existing: Bool) {
    guard let nonce = nonceBook.nonce("hand"), let data = try? JSONSerialization.data(withJSONObject:
        ["hand": "menu-ready", "nonce": nonce, "existing": existing]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
// The same plan controls the live menu and the no-window dump.
struct SettingsMenuPlan {
    let menuOnly: Bool
    var pause: Bool { !menuOnly }
    var quit: Bool { menuOnly }
    var cursor: Bool { menuOnly }
    func visible(retiring: Bool, owns: Bool) -> Bool { !retiring && (!menuOnly || owns) }
    var json: [String: Any] { ["pause": pause, "resume": pause, "quit": quit, "drawsCursor": !menuOnly,
        "extraRows": quit ? ["Quit Menu"] : []] }
}
final class ConsentHost: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var settingsMenu = false, settingsReady = false
    let menuInstance = MenuInstance()
    var menuRetry: Timer?
    let cursorPause = CursorPauseControl()
    var cursorControlSession = false
    var controlRetiring = false
    lazy var item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
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
        if channelValidationOnly { return }
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
        if !channelValidationOnly { item.isVisible = false }
        // Posted on the main thread before the activating click is handled; nil queue runs it there and then.
        NotificationCenter.default.addObserver(forName: NSApplication.willBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
            self?.focus.hostActivating()
        }
    }
    func personModal(_ alert: NSAlert, choices: [String], kind: String) -> NSApplication.ModalResponse {
        if channelValidationOnly { return .abort }
        let actions = consentInputActions(alert, choices: choices, kind: kind)
        defer { for action in actions { action.typing?.invalidate() } }
        focus.presenting([:])
        consentArming(alert.window).presented()
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
        if !channelValidationOnly {
            if let image = glyphImage(menuGlyph) { item.button?.image = image } else { item.button?.title = "sleight" }
            item.isVisible = false
            item.menu = NSMenu()
            if !settingsMenu { rebuildMenu() }
        }
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
        if shared, frame["hand"] as? String == "control-exit" {
            guard handControlExit(frame, nonce: nonceBook.nonce("hand")) else { exit(65) }
            retireControl(); closeAsk(); modal.close(); pending.removeAll()
            NSApp.terminate(nil); return
        }
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
                let entry = NSMenuItem(title: "Permissions", action: nil, keyEquivalent: ""), submenu = CursorPickerMenu()
                submenu.permissionsRoot = true
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
        if channelValidationOnly { return }
        let menu = CursorPickerMenu(); menu.addWindowProbe()
        let plan = SettingsMenuPlan(menuOnly: settingsMenu)
        if plan.pause && !controlRetiring {
            let entry = CursorPauseMenuItem(title: cursorPause.failed ? "Pause not confirmed. Try again" : cursorPause.paused ? "Resume sleight" : "Pause sleight", action: #selector(cursorPauseClick(_:)), keyEquivalent: "")
            entry.target = self; menu.addItem(entry); menu.addItem(NSMenuItem.separator())
        }
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
        cursorPicker.install(in: menu, enabled: plan.cursor || hand?.enabled == true)
#if SLEIGHT_SEALED_SETTINGS
        menu.addItem(NSMenuItem(title: settingsMenuSealLine(), action: nil, keyEquivalent: ""))
#endif
        if plan.quit {
            menu.addItem(NSMenuItem.separator())
            let quit = CursorPickerMenuItem(title: "Quit Menu", action: #selector(quitMenu(_:)), keyEquivalent: "")
            quit.target = self; menu.addItem(quit)
        }
        menu.delegate = self
        item.menu = menu
        // Session presence is registered at launch, even before the first hand/status frame. Its menu never depends on a
        // successful lock. A failed session registration retries; the standalone polls until a session is present.
        let owns = controlRetiring ? false : menuInstance.claim(standalone: settingsMenu)
        item.isVisible = plan.visible(retiring: controlRetiring, owns: owns)
        menuRetry?.invalidate(); menuRetry = nil
        if !controlRetiring && (settingsMenu && item.isVisible || !settingsMenu && menuInstance.reason != nil) {
            let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                let owns = self.menuInstance.claim(standalone: self.settingsMenu)
                if self.settingsMenu && !owns { self.item.isVisible = false; NSApp.terminate(nil) }
                else if !self.settingsMenu && self.menuInstance.reason == nil { self.menuRetry?.invalidate(); self.menuRetry = nil }
            }
            menuRetry = timer; RunLoop.main.add(timer, forMode: .common)
        }
        if settingsMenu && !settingsReady {
            settingsReady = true
            if owns || ["session-present", "held-lock"].contains(menuInstance.reason ?? "") { writeMenuReady(!item.isVisible) }
        }
        if settingsMenu && !item.isVisible { NSApp.terminate(nil) }
    }
    // Hide before reporting the fault, so a replacement never appears beside an obsolete status item.
    func retireControl() { menuRetry?.invalidate(); menuRetry = nil; menuInstance.release(); controlRetiring = true; hookupTimer?.invalidate(); hookupTimer = nil; if !channelValidationOnly { item.isVisible = false } }
    // The shared host's consent channel ended (its worker exited): an open card is aborted, its requests and status go, and the
    // hand stays.
    func channelClosed() { closeAsk(); modal.close(); pending.removeAll(); status = nil; consentOpen = false; rebuildMenu(); if !handOpen { NSApp.terminate(nil) } }
    // The hand channel ended or faulted: its state goes, and turbo's channel, if open, keeps the host.
    func handGone() { handOpen = false; hand = nil; permissions = nil; usage = nil; cursorControlSession = false; cursorPause.changed = nil; cursorPause.set(false); rebuildMenu(); if !consentOpen { NSApp.terminate(nil) } }
    func handState(enabled: Bool, version: String, permissions: PermissionsData?, usage: UsageStats?) {
        hand = (enabled, version); self.permissions = permissions; self.usage = usage; rebuildMenu()
    }
    var permissionMenu: [PermissionRow]? { permissions.map { permissionRows($0, now: Date().timeIntervalSince1970) } }
    func fillPermissions(_ submenu: NSMenu) {
        submenu.removeAllItems()
        (submenu as? CursorPickerMenu)?.addWindowProbe()
        for row in permissionMenu ?? [] {
            switch row {
            case let .grant(title, target):
                let entry = NSMenuItem(title: title, action: nil, keyEquivalent: ""), inner = CursorPickerMenu()
                inner.delegate = self; inner.addWindowProbe()
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
        if menu === item.menu { return }
        if (menu as? CursorPickerMenu)?.permissionsRoot == true { fillPermissions(menu) }
    }
    // Revoke and block only remove access, so they don't ask.
    @objc func permissionClick(_ sender: NSMenuItem) {
        guard personMenuActivation(sender) else { return }
        guard let event = sender.representedObject as? [String: String] else { return }
        writePermissionEvent(event)
    }
    @objc func quitMenu(_ sender: NSMenuItem) {
        guard settingsMenu, personMenuActivation(sender) else { return }
        NSApp.terminate(nil)
    }
    @objc func handToggle(_ sender: NSMenuItem) {
        guard personMenuActivation(sender) else { return }
        guard let hand = hand else { return }
        writeHandToggle(!hand.enabled)
    }
    func menuWillOpen(_ menu: NSMenu) {
        (menu as? CursorPickerMenu)?.lastHighlighted = nil
        if menu === item.menu, settingsMenu || hand?.enabled == true { writeCursorPickerEvent(["op": "refresh"]) }
    }
    func menu(_ menu: NSMenu, willHighlight entry: NSMenuItem?) { if let entry = entry { (menu as? CursorPickerMenu)?.lastHighlighted = entry } }
    @objc func cursorPauseClick(_ sender: NSMenuItem) {
        guard let menu = sender.menu as? CursorPickerMenu, let window = menu.trackingWindow else { return }
        _ = cursorPause.click(NSApp.currentEvent, windowMatches: NSApp.currentEvent?.window === window,
            highlighted: sender.isHighlighted || menu.lastHighlighted === sender)
    }
    // Turbo's connect hookup on the menu bar button: a template image per frame, then the glyph, and the timer is gone.
    func hookup() {
        if channelValidationOnly { return }
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
        guard personMenuActivation(sender) else { return }
        guard let event = sender.representedObject as? [String: String], let id = event["id"], let choice = event["choice"] else { return }
        respond(id, choice)
    }
    // Turning turbo off lasts past this session and reaches every session, so it asks once.
    @objc func confirmOff(_ sender: NSMenuItem) {
        guard personMenuActivation(sender) else { return }
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
        guard personMenuActivation(sender) else { return }
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
        guard personMenuActivation(sender) else { return }
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


// BEGIN NARRATION
// Data-only assistant prose. Recheck here even when a caller bypasses the relay's cutter.
func narrationText(_ raw: Any?) -> String? {
    guard let raw = raw as? String, raw.utf8.count <= 1024 else { return nil }
    var text = raw.precomposedStringWithCanonicalMapping
    for pattern in [#"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*(?:`|$)"#,
        #"\"[^\"\n]*(?:\"|$)|“[^”\n]*(?:”|$)|(?<![\p{L}])'[^'\n]+'(?=\s|[.,!?]|$)"#] {
        text = text.replacingOccurrences(of: pattern, with: " ", options: .regularExpression)
    }
    // Check every card-sized window in a numeric run, including adjacent digit groups.
    if let re = try? NSRegularExpression(pattern: #"[0-9](?:[ -]?[0-9])*"#) {
        for match in re.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: text) else { continue }
            let digits = text[range].compactMap { $0.wholeNumberValue }
            guard digits.count >= 13 else { continue }
            var card = false
            for start in 0...(digits.count - 13) {
                var plainFirst = 0, doubledFirst = 0
                for length in 1...min(19, digits.count - start) {
                    let n = digits[start + length - 1], doubled = n * 2 > 9 ? n * 2 - 9 : n * 2
                    plainFirst += length % 2 == 1 ? n : doubled
                    doubledFirst += length % 2 == 1 ? doubled : n
                    if length >= 13, (length % 2 == 1 ? plainFirst : doubledFirst) % 10 == 0 { card = true; break }
                }
                if card { break }
            }
            if card { text.replaceSubrange(range, with: " ") }
        }
    }
    text = text.components(separatedBy: .whitespacesAndNewlines).filter { token in
        ![#"[/:\\@]|\.[a-zA-Z]{2,8}(?:\b|$)"#,
          #"(?i)(?:sk-(?:ant-)?|gh[pousr]_|xox[a-z]?[-_]|AKIA)[A-Za-z0-9_+\-]+"#,
          #"[A-Fa-f0-9]{24,}|[A-Za-z0-9+/=_\-]{32,}|[0-9]{6,}"#,
          #"(?=[A-Za-z0-9_\-]*[A-Za-z])(?=[A-Za-z0-9_\-]*[0-9])[A-Za-z0-9_\-]{8,}"#].contains {
            token.range(of: $0, options: .regularExpression) != nil
        }
    }.joined(separator: " ")
    text = text.replacingOccurrences(of: #"[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]|[*_#>|\[\]{}]"#, with: " ", options: .regularExpression)
    text = text.replacingOccurrences(of: #"\s+([.!?,])"#, with: "$1", options: .regularExpression)
        .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    if let end = text.range(of: #"[.!?](?=\s|$)"#, options: .regularExpression) { text = String(text[...end.lowerBound]) }
    var out = ""
    for character in text.prefix(90) {
        guard out.unicodeScalars.count + character.unicodeScalars.count <= 180 else { break }
        out.append(character)
    }
    return out.range(of: #"[\p{L}\p{N}\p{So}]"#, options: .regularExpression) == nil ? nil : out
}
struct NarrationOptions: Equatable {
    var mode = "off", id: String? = nil, rate: Float = 0.5
    static func parse(_ data: [String: Any]) -> NarrationOptions? {
        var result = NarrationOptions()
        if let mode = data["narration"] {
            guard let mode = mode as? String, ["off", "bubbles", "voice"].contains(mode) else { return nil }
            result.mode = mode
        }
        if let raw = data["voice"] {
            guard let voice = raw as? [String: Any], Set(voice.keys).isSubset(of: ["id", "rate"]), let id = voice["id"] as? String,
                id.range(of: #"^[A-Za-z0-9._-]{1,200}$"#, options: .regularExpression) != nil,
                voice["rate"] == nil || (voice["rate"] is NSNumber) else { return nil }
            if let raw = voice["rate"] {
                guard let rate = raw as? NSNumber, CFGetTypeID(rate) != CFBooleanGetTypeID(), rate.doubleValue.isFinite,
                    (0.1...0.6).contains(rate.doubleValue) else { return nil }
                result.rate = rate.floatValue
            }
            result.id = id
        }
        return result
    }
    func select(_ installed: [String]) -> String? { id == nil ? installed.first : installed.first { $0 == id } }
}
struct NarrationQueue {
    var active: String?, queued: String?, last: String?, lastAt = -Double.infinity
    mutating func offer(_ text: String, now: Double = ProcessInfo.processInfo.systemUptime) -> String? {
        guard text != last || now - lastAt >= 10 else { return nil }; last = text; lastAt = now
        if active != nil { queued = text; return nil }
        active = text; return text
    }
    mutating func finish() -> String? { active = queued; queued = nil; return active }
    mutating func cancel() { active = nil; queued = nil }
}
struct NarrationBubble {
    let text: String, spoken: String, frame: CGRect
    var tail: String? = nil
    var json: [String: Any] { ["text": text, "spoken": spoken, "frame": [frame.minX, frame.minY, frame.width, frame.height],
        "fontSize": 11, "lineHeight": 14, "padding": [9, 6], "radius": 8, "rim": 0.6, "tail": tail as Any? ?? NSNull()] }
    static func attach(_ plan: inout RingPlan, say: String?, clip: CGRect, secure: Bool, options: NarrationOptions,
                       previous: NarrationBubble?, reduced: Bool, ink: [Double]) {
        guard options.mode != "off", !secure, let text = narrationText(say) else { return }
        let font = NSFont.systemFont(ofSize: 11)
        func measure(_ t: String) -> Double { Double((t as NSString).size(withAttributes: [.font: font]).width) }
        // Reserve the 12 pt voice inset so speaking never changes line wrapping or stack geometry.
        let inset = options.mode == "voice" ? 12.0 : 0, contentCap = 222.0 - inset
        var lines = [String](), current = "", truncated = false
        for word in text.split(separator: " ").map(String.init) {
            let trial = current.isEmpty ? word : current + " " + word
            if !current.isEmpty && measure(trial) > contentCap {
                lines.append(current); current = word
                if lines.count == 2 { truncated = true; break }
            } else { current = trial }
        }
        if lines.count < 2 && !current.isEmpty { lines.append(current) }
        guard !lines.isEmpty else { return }
        if truncated || measure(lines.last!) > contentCap {
            var last = lines.removeLast()
            while !last.isEmpty && measure(last + "…") > contentCap { last.removeLast() }
            lines.append(last + "…")
        }
        let width = min(240, max(60, (lines.map(measure).max() ?? 0) + 18 + inset)), height = lines.count == 1 ? 26.0 : 40.0
        let point = CGRect(x: plan.at.x - 12, y: plan.at.y - 12, width: 24, height: 24)
        let avoid = plan.rect.map { $0.union(point) } ?? point
        var frame: CGRect, tail: String? = nil
        if let sprite = plan.sprite {
            let box = sprite.bounds(plan)
            let candidate = CGRect(x: box.midX - width / 2, y: box.minY - 6 - height, width: width, height: height)
            let above = candidate.minY >= clip.minY && !candidate.intersects(avoid) && !(plan.chip?.frame.intersects(candidate) ?? false)
            frame = CGRect(x: candidate.minX, y: above ? candidate.minY : max(box.maxY + 6, avoid.maxY + 4), width: width, height: height)
            tail = above ? "down" : "up"
        } else {
            let chipHeight = plan.chip == nil ? 0.0 : 16.0, gap = chipHeight == 0 ? 0.0 : 4.0
            let stackWidth = max(width, plan.chip?.frame.width ?? 0)
            let right = plan.at.x + 18 + stackWidth <= clip.maxX
            let x = max(clip.minX, right ? plan.at.x + 18 : plan.at.x - 18 - stackWidth)
            let bottom = min(plan.at.y - 25, avoid.minY - 4)
            let above = bottom - chipHeight - gap - height >= clip.minY
            let chipY = above ? bottom - chipHeight : max(plan.at.y + 25, avoid.maxY + 4)
            frame = CGRect(x: x, y: above ? bottom - chipHeight - gap - height : chipY + chipHeight + gap, width: width, height: height)
            if let chip = plan.chip {
                let newFrame = CGRect(x: x, y: chipY, width: chip.frame.width, height: 16)
                let tether = [[0.0, Double(plan.at.x) + (right ? 11 : -11), Double(plan.at.y) - 11],
                    [1, right ? x : x + newFrame.width, above ? newFrame.maxY : newFrame.minY]]
                plan.chip = RingChip(frame: newFrame, tether: tether)
                for i in plan.layers.indices {
                    if plan.layers[i].name == "chip" { plan.layers[i].frame = newFrame }
                    if plan.layers[i].name == "tether" { plan.layers[i].props["path"] = .path(tether) }
                }
            } else {
                plan.layers.append(RingLayer(name: "narrationTether", parent: "root", global: true, stroke: ink, width: 1,
                    props: ["path": .path([[0, Double(plan.at.x) + (right ? 11 : -11), Double(plan.at.y) - 11],
                        [1, right ? x : x + width, above ? frame.maxY : frame.minY]])]))
            }
        }
        guard !frame.intersects(avoid), !(plan.chip?.frame.intersects(frame) ?? false) else { return }
        let bubble = NarrationBubble(text: lines.joined(separator: "\n"), spoken: text, frame: frame, tail: tail)
        plan.bubble = bubble
        let same = previous?.spoken == text, changed = previous != nil && !same
        if changed { plan.oldBubble = previous }
        // A group follows position only. Its body includes the sprite tail in the same path.
        let x = Double(frame.minX), y = Double(frame.minY), w = Double(frame.width), h = Double(frame.height), r = 8.0
        var body: [[Double]] = [[0,x+r,y]]
        if tail == "up" { body += [[1,x+w/2-4,y],[1,x+w/2,y-5],[1,x+w/2+4,y]] }
        body += [[1,x+w-r,y], [2,x+w,y,x+w,y+r], [1,x+w,y+h-r], [2,x+w,y+h,x+w-r,y+h]]
        if tail == "down" { body += [[1,x+w/2+4,y+h],[1,x+w/2,y+h+5],[1,x+w/2-4,y+h]] }
        body += [[1,x+r,y+h],[2,x,y+h,x,y+h-r],[1,x,y+r],[2,x,y,x+r,y]]
        body.append([3])
        let tether = plan.layers.filter { $0.name == "narrationTether" }
        plan.layers.removeAll { $0.name == "narrationTether" }
        plan.layers.append(RingLayer(name: "narration", parent: "root", global: true, stroke: [1,1,1,0.12], fill: ink, width: 0.6,
            props: ["path": .path(body), "opacity": .number(1)]))
        for var layer in tether { layer.parent = "narration"; plan.layers.append(layer) }
        plan.layers.append(RingLayer(name: "narrationText", kind: .text, parent: "narration", global: true,
            stroke: [1,1,1,0.92], text: bubble.text, frame: frame.insetBy(dx: 9, dy: 6), props: [:]))
        // Copy position without the ring's scale, lean, stretch or rotation.
        if !plan.positions.isEmpty {
            let values = plan.positions.map { RingValue.vector([Double($0.1.x - plan.at.x), Double($0.1.y - plan.at.y)]) }
            let end = max(0.001, plan.positions.last!.0)
            for name in ["narration", "chip", "tether"] where plan.layers.contains(where: { $0.name == name }) {
                plan.tracks.append(RingTrack(layer: name, keyPath: "transform.translation", begin: 0, duration: end,
                    values: values, times: plan.positions.map { $0.0 / end }))
            }
        }
        let start = changed ? 0.06 : 0.0
        if !same {
            plan.tracks.append(RingTrack(layer: "narration", keyPath: "opacity", begin: start, duration: 0.09,
                values: [.number(0), .number(1)], times: [0,1]))
            if !reduced { plan.tracks.append(RingTrack(layer: "narration", keyPath: "position.y", begin: start, duration: 0.09,
                values: [.number(4), .number(0)], times: [0,1])) }
        }
        if changed { plan.tracks.append(RingTrack(layer: "oldNarration", keyPath: "opacity", begin: 0, duration: 0.06,
            values: [.number(1), .number(0)], times: [0,1])) }
        if ["done", "handback"].contains(plan.state) {
            plan.tracks.removeAll { $0.layer == "narration" && $0.keyPath == "opacity" }
            plan.tracks.append(RingTrack(layer: "narration", keyPath: "opacity", begin: 0, duration: 0.22,
                values: [.number(1), .number(0)], times: [0,1]))
        }
        let motionEnd = plan.tracks.map { $0.begin + $0.duration }.max() ?? plan.total
        if motionEnd > plan.total {
            plan.total = motionEnd
            plan.timers = plan.timers.map { RingTimer(at: $0.action == "park" ? max($0.at, motionEnd) : $0.at, action: $0.action) }
        }
        plan.budget["layers", default: 0] += 2; plan.budget["visible", default: 0] += 2
    }
}
// Read-only Core Audio metadata, never a microphone capture or audio-session activation.
// Unknown output state fails closed. Running input is a conservative call proxy, including recordings.
struct NarrationAudioLayer {
    var secure: () -> Bool
    var word: (AudioObjectID, AudioObjectPropertySelector, AudioObjectPropertyScope, AudioObjectPropertyElement) -> UInt32?
    var scalar: (AudioObjectID, AudioObjectPropertySelector, AudioObjectPropertyScope, AudioObjectPropertyElement) -> Float32?
    var processes: () -> [AudioObjectID]?
}
enum NarrationAudio {
    static let system = NarrationAudioLayer(secure: { IsSecureEventInputEnabled() }, word: { object, selector, scope, element in
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element), value: UInt32 = 0, size: UInt32 = 4
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, size == 4 else { return nil }
        return value
    }, scalar: { object, selector, scope, element in
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element), value: Float32 = 0, size: UInt32 = 4
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, size == 4 else { return nil }
        return value.isFinite ? value : nil
    }, processes: {
        guard #available(macOS 14.2, *) else { return nil }
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
            size <= 65536, size % 4 == 0 else { return nil }
        if size == 0 { return [] }
        var objects = [AudioObjectID](repeating: 0, count: Int(size) / 4)
        let expected = size
        let status = objects.withUnsafeMutableBytes { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }
        return status == noErr && size == expected ? objects : nil
    })
    // The same function runs against the live Core Audio adapter or the selftest's fake adapter.
    static func safe(_ audio: NarrationAudioLayer = system, explain: (String) -> Void = { _ in }) -> Bool {
        func no(_ reason: String) -> Bool { explain(reason); return false }
        guard !audio.secure() else { return no("secure-input") }
        guard let output = audio.word(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
            kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain), output != 0 else { return no("unknown-output") }
        let scope = kAudioDevicePropertyScopeOutput, main = kAudioObjectPropertyElementMain
        let mainMute = audio.word(output, kAudioDevicePropertyMute, scope, main)
        let mainVolume = audio.scalar(output, kAudioDevicePropertyVolumeScalar, scope, main)
        var audible = false
        let channels: [UInt32] = mainMute != nil && mainVolume != nil ? [main] : [1,2]
        for channel in channels {
            guard let mute = mainMute ?? audio.word(output, kAudioDevicePropertyMute, scope, channel) else { return no("unknown-mute") }
            guard let volume = mainVolume ?? audio.scalar(output, kAudioDevicePropertyVolumeScalar, scope, channel), volume.isFinite else { return no("unknown-volume") }
            audible = audible || mute == 0 && volume > 0
        }
        guard audible else { return no("muted-output") }
        guard let objects = audio.processes() else { return no("unknown-input") }
        if #available(macOS 14.2, *) {
            for object in objects {
                guard let running = audio.word(object, kAudioProcessPropertyIsRunningInput, kAudioObjectPropertyScopeGlobal, main) else { return no("unknown-input") }
                if running != 0 { return no("input-active") }
            }
            return true
        }
        return no("unknown-input")
    }
}
// No polling thread or timer while idle. Main-thread callers only inspect this cached result.
// Each refresh runs all Core Audio property reads on a utility queue, at most once per 500 ms.
final class NarrationAudioMonitor {
    var checked = -Double.infinity, refreshed = -Double.infinity, pending = false, allowed = false, explained = false
    var onChecked: ((Bool) -> Void)?
    var audio = NarrationAudio.system
    func safe(now: Double = ProcessInfo.processInfo.systemUptime) -> Bool {
        if !pending && now - checked >= 0.5 {
            checked = now; pending = true
            let layer = audio
            DispatchQueue.global(qos: .utility).async { [weak self] in
                var reason: String?
                let result = NarrationAudio.safe(layer, explain: { reason = $0 })
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.pending = false; self.allowed = result; self.refreshed = ProcessInfo.processInfo.systemUptime
                    if !result {
                        if !self.explained { self.explained = true
                            FileHandle.standardError.write(Data(("sleight narration silent: " + (reason ?? "unknown-audio") + ". Unknown audio metadata fails closed.\n").utf8)) }
                    }
                    self.onChecked?(result)
                }
            }
        }
        return allowed && now - refreshed <= 1
    }
}
func narrationVoices() -> [AVSpeechSynthesisVoice] {
    AVSpeechSynthesisVoice.speechVoices().filter { !$0.voiceTraits.contains(.isPersonalVoice) }.sorted {
        let language = AVSpeechSynthesisVoice.currentLanguageCode()
        let a = $0.language == language, b = $1.language == language
        if a != b { return a }
        if $0.quality != $1.quality { return $0.quality.rawValue > $1.quality.rawValue }
        return $0.identifier < $1.identifier
    }
}
final class LocalNarrator: NSObject, AVSpeechSynthesizerDelegate {
    var options = NarrationOptions(), queue = NarrationQueue()
    var synthesizer: AVSpeechSynthesizer?, selected: AVSpeechSynthesisVoice?, utterance: AVSpeechUtterance?
    var selectedId: String?, pendingLine: String?, began = 0.0, speaking = false
    let monitor = NarrationAudioMonitor()
    var testInstalled: [String]?, testSafe: (() -> Bool)?, testPlay: ((String) -> Void)?, testStop: (() -> Void)?
    var clock: () -> Double = { ProcessInfo.processInfo.systemUptime }
    var secure: () -> Bool = { IsSecureEventInputEnabled() }
    var speakingChanged: ((Bool) -> Void)?
    override init() {
        super.init()
        monitor.onChecked = { [weak self] allowed in
            guard let self = self else { return }
            if !allowed { self.stop() }
            else if let line = self.pendingLine { self.pendingLine = nil; self.offer(line) }
        }
    }
    func configure(_ next: NarrationOptions) {
        guard next != options else { return }; stop(); queue = NarrationQueue(); options = next; selected = nil; selectedId = nil
        if next.mode == "voice" {
            if let installed = testInstalled { selectedId = next.select(installed) }
            else {
                let voices = narrationVoices()
                selected = next.select(voices.map { $0.identifier }).flatMap { id in voices.first { $0.identifier == id } }
                selectedId = selected?.identifier
            }
        }
    }
    func safe() -> Bool { testSafe?() ?? (!secure() && monitor.safe()) }
    func offer(_ raw: String?) {
        guard options.mode == "voice", selectedId != nil, let line = narrationText(raw) else { return }
        guard safe() else {
            if testSafe == nil, !secure(), monitor.pending { pendingLine = line }
            else { stop() }
            return
        }
        pendingLine = nil
        if let start = queue.offer(line, now: clock()) { speak(start) }
    }
    func speak(_ line: String) {
        guard safe() else { stop(); return }
        began = clock()
        if let play = testPlay { play(line); return }
        guard let voice = selected else { stop(); return }
        if synthesizer == nil { synthesizer = AVSpeechSynthesizer(); synthesizer?.delegate = self }
        let u = AVSpeechUtterance(string: line); u.voice = voice; u.rate = options.rate
        utterance = u; synthesizer?.speak(u)
    }
    func stop() { utterance = nil; pendingLine = nil; queue.cancel(); speaking = false; speakingChanged?(false); testStop?(); synthesizer?.stopSpeaking(at: .immediate) }
    @discardableResult func tick() -> Bool {
        guard queue.active != nil else { return false }
        let timedOut = clock() - began >= 15
        if timedOut || !safe() { stop() }
        return timedOut
    }
    func finished() { utterance = nil; speaking = false; speakingChanged?(false); if let next = queue.finish() { speak(next) } }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        guard self.utterance === utterance else { return }; speaking = true; speakingChanged?(true)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        guard self.utterance === utterance else { return }; finished()
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        guard self.utterance === utterance else { return }; stop()
    }
}
func narrationJSON(_ value: Any) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]) else { exit(70) }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
func narrationInput() -> [String: Any] {
    var bytes = Data()
    while bytes.count <= 8192 { let chunk = FileHandle.standardInput.availableData; if chunk.isEmpty { break }; bytes.append(chunk) }
    guard bytes.count <= 8192, let input = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
    return input
}
func narrationAudioSelftest() {
    let input = narrationInput(), gate = input["gate"] as? String ?? "safe"
    var reads = 0, reasons = [String]()
    let layer = NarrationAudioLayer(secure: { gate == "secure" }, word: { _, selector, _, element in
        reads += 1
        if selector == kAudioHardwarePropertyDefaultOutputDevice { return gate == "unknown-output" ? nil : 42 }
        if selector == kAudioDevicePropertyMute {
            if gate == "unknown-mute" { return nil }
            if ["channels", "split-muted"].contains(gate), element == kAudioObjectPropertyElementMain { return nil }
            if gate == "split-muted" { return element == 1 ? 0 : 1 }
            return gate == "muted" ? 1 : 0
        }
        return gate == "microphone" ? 1 : gate == "unknown-process" ? nil : 0
    }, scalar: { _, _, _, element in
        if gate == "split-muted" { return element == kAudioObjectPropertyElementMain ? nil : element == 1 ? 0 : 0.5 }
        return gate == "unknown-volume" ? nil : gate == "zero-volume" ? 0 : 0.5
    },
        processes: { gate == "unknown-input" ? nil : [100,101] })
    if input["monitor"] as? Bool == true {
        let monitor = NarrationAudioMonitor()
        var probes = 0, offMain = true
        var fake = layer
        let original = layer.processes
        fake.processes = { probes += 1; offMain = offMain && !Thread.isMainThread; return original() }
        monitor.audio = fake
        func wait() { let until = Date().addingTimeInterval(2)
            while monitor.pending && Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001)) }
        }
        _ = monitor.safe(now: 0); wait()
        _ = monitor.safe(now: 0.1); _ = monitor.safe(now: 0.499); wait()
        _ = monitor.safe(now: 0.5); wait()
        _ = monitor.safe(now: 0.999); _ = monitor.safe(now: 1); wait()
        narrationJSON(["probes": probes, "offMain": offMain, "pending": monitor.pending]); return
    }
    let allowed = NarrationAudio.safe(layer, explain: { reasons.append($0) })
    narrationJSON(["safe": allowed, "reasons": reasons, "propertyReads": reads])
}
func narrationSelftest() {
    let input = narrationInput()
    guard let installed = input["installed"] as? [String], let lines = input["lines"] as? [Any], let options = NarrationOptions.parse(input) else { exit(65) }
    let narrator = LocalNarrator()
    var started = [String](), stops = 0, clock = 0.0, safe = true
    narrator.testInstalled = installed; narrator.testSafe = { safe }; narrator.testPlay = { started.append($0) }; narrator.testStop = { stops += 1 }
    narrator.clock = { clock }
    if input["asyncAudio"] as? Bool == true {
        narrator.testSafe = nil; narrator.secure = { false }
        narrator.monitor.audio = NarrationAudioLayer(secure: { false }, word: { _, selector, _, _ in
            selector == kAudioHardwarePropertyDefaultOutputDevice ? 42 : 0
        }, scalar: { _,_,_,_ in 0.5 }, processes: { [] })
    }
    var configured = options; configured.mode = "voice"; narrator.configure(configured)
    for line in lines {
        if line is NSNull { narrator.finished() }
        else if let event = line as? [String: Any] {
            if let time = event["time"] as? Double { clock = time; narrator.tick() }
            if event["gate"] != nil { safe = false; narrator.tick() }
            if event["cancel"] != nil { narrator.stop() }
        } else { narrator.offer(line as? String) }
    }
    let until = Date().addingTimeInterval(2)
    while narrator.monitor.pending && Date() < until { _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.001)) }
    narrationJSON(["selected": narrator.selectedId as Any? ?? NSNull(), "rate": narrator.options.rate, "started": started, "stops": stops,
        "active": narrator.queue.active as Any? ?? NSNull(), "queued": narrator.queue.queued as Any? ?? NSNull()])
}
func narrationBufferDump() {
    let input = narrationInput()
    guard let line = narrationText(input["say"]), let options = NarrationOptions.parse(input) else { exit(65) }
    let voices = narrationVoices()
    guard let id = options.select(voices.map { $0.identifier }), let voice = voices.first(where: { $0.identifier == id }) else {
        narrationJSON(["played": false, "reason": "voice-not-installed", "frames": 0]); return
    }
    func cpu() -> Double { var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
        return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000 }
    let synthesizer = AVSpeechSynthesizer(), utterance = AVSpeechUtterance(string: line), lock = NSLock()
    utterance.voice = voice; utterance.rate = options.rate
    var frames: UInt64 = 0, done = false
    let start = ProcessInfo.processInfo.systemUptime, before = cpu()
    synthesizer.write(utterance) { buffer in
        guard let pcm = buffer as? AVAudioPCMBuffer else { return }
        lock.lock(); frames += UInt64(pcm.frameLength); if pcm.frameLength == 0 { done = true }; lock.unlock()
    }
    while ProcessInfo.processInfo.systemUptime - start < 15 {
        lock.lock(); let finished = done; lock.unlock(); if finished { break }
        _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01))
    }
    lock.lock(); let count = frames, completed = done; lock.unlock()
    let wall = (ProcessInfo.processInfo.systemUptime - start) * 1000, cost = cpu() - before
    if !completed { synthesizer.stopSpeaking(at: .immediate) }
    narrationJSON(["played": false, "completed": completed, "frames": count, "cpuMs": cost, "wallMs": wall, "hostCpuPercent": cost / max(1, wall) * 100])
    if !completed { exit(70) }
}
// END NARRATION

// BEGIN HAND FRAME
// The ghost hand's stdin frames: a kind and global top-left screen points, nonce-bound and never answered. Exact keys only.
struct HandAct {
    let seq: Int, kind: String, pid: Int32, windowId: UInt32, at: CGPoint, path: [CGPoint], delay: Double, beats: Int
    var label: String? = nil
    var say: String? = nil
    var windowRect: CGRect? = nil
    var rect: CGRect? = nil, caretX: Double? = nil
    var retry = false, transfer: String? = nil
}
// menu: the hand's setting, capture mode and the plugin version, for the shared host's Ghost Hand row.
// permissions: the Permissions submenu's rows (permissionsData), when the relay has them. usage: the usage row (usageData),
// when this session writes the action log and it has timed actions. A usage value this host can't admit drops only that row:
// a bad number must never take the glove down.
struct RingEvent {
    let seq: Int, state: String, pid: Int32, windowId: UInt32, at: CGPoint?, rect: CGRect?, label: String?
    var windowRect: CGRect? = nil
    var say: String? = nil
    var path: [CGPoint] = []
    var beats: Int = 1
    var caretX: Double? = nil, holdMs = 0, ok = false
    var detail: String? = nil, retry = false, transfer: String? = nil
    var producer: StageProducerIdentity? = nil
    var area: String? = nil
    var wideName: String? = nil, wideReason: String? = nil
    var wideEpoch: Int? = nil
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
            Set(row.keys).isSubset(of: ["title", "op", "style", "character", "selected", "key", "children", "reason", "size"]) else { return false }
        if let children = row["children"] as? [[String: Any]] {
            return !nested && Set(row.keys) == ["title", "children"] && children.count <= 512 && children.allSatisfy { valid($0, nested: true) }
        }
        switch row["op"] as? String {
        case "select":
            guard let style = row["style"] as? String, let on = row["selected"] as? NSNumber,
                CFGetTypeID(on) == CFBooleanGetTypeID() else { return false }
            if style == "sprite" {
                return Set(row.keys) == ["title", "op", "style", "character", "selected"] &&
                    (row["character"] as? String)?.range(of: "^[a-z0-9-]{1,48}$", options: .regularExpression) != nil
            }
            return !nested && ["ring", "seam", "glove"].contains(style) && Set(row.keys) == ["title", "op", "style", "selected"]
        case "size": return sizeRowValid(row, nested: nested)
        case "import":
            return nested && Set(row.keys) == ["title", "op", "key"] &&
                (row["key"] as? String)?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
        case "installed": return nested && Set(row.keys) == ["title", "op"]
        case "skipped":
            guard nested, Set(row.keys) == ["title", "op", "reason"], let reason = row["reason"] as? String,
                (1...1000).contains(reason.count) else { return false }
            return reason.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) && $0.properties.generalCategory != .format }
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
// ST10 keeps the size menu and grouped-character traversal out of the placement runtime.
extension CursorPickerRow {
    static func sizeRowValid(_ row: [String: Any], nested: Bool) -> Bool {
        guard nested, Set(row.keys) == ["title", "op", "size", "selected"],
            let size = row["size"] as? String, ["small", "medium", "stage"].contains(size),
            let selected = row["selected"] as? NSNumber else { return false }
        return CFGetTypeID(selected) == CFBooleanGetTypeID()
    }
    static func characterIDs(_ rows: [[String: Any]]) -> Set<String> {
        Set(rows.flatMap { row -> [String] in
            if let id = row["character"] as? String { return [id] }
            return (row["children"] as? [[String: Any]] ?? []).compactMap { $0["character"] as? String }
        })
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
    var permissionsRoot = false
    func addWindowProbe() {
        let probe = CursorPickerWindowProbe(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        probe.owner = self; probe.setAccessibilityElement(false)
        let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
        item.view = probe; item.isEnabled = false; addItem(item)
    }
}
func personMenuActivation(_ sender: NSMenuItem) -> Bool {
    guard let menu = sender.menu as? CursorPickerMenu, let window = menu.trackingWindow,
        personActivation(NSApp.currentEvent, in: window, highlighted: sender.isHighlighted || menu.lastHighlighted === sender)
        else { refuseConsentInput(); return false }
    return true
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
                if row["op"] as? String == "installed" { entry.isEnabled = false; entry.action = nil }
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
        guard personMenuActivation(sender) else { refuseSelection(); return }
        guard let row = sender.representedObject as? [String: Any], CursorPickerRow.valid(row, nested: sender.menu !== submenu) else { return }
        if row["op"] as? String == "skipped" {
            showNotice("\(row["title"] as! String)\n\(row["reason"] as! String)"); return
        }
        if row["op"] as? String == "folder" {
            // A click opens the existing folder in Finder. No shell or script receives the path.
            do {
                let directory = try CursorThumbnailCache.directory(SpriteCharacter.root()); close(directory)
                if !NSWorkspace.shared.open(URL(fileURLWithPath: SpriteCharacter.root(), isDirectory: true)) { showNotice("The characters folder could not open.") }
            } catch { showNotice("The characters folder is unsafe to open. Check its owner, permissions and links.") }
            return
        }
        var event: [String: String] = [:]
        for key in ["op", "style", "character", "key", "size"] { if let value = row[key] as? String { event[key] = value } }
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
            let ids = CursorPickerRow.characterIDs(rows); images = images.filter { ids.contains($0.key) }
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
        if channelValidationOnly { return }
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
            menu.addItem(NSMenuItem(title: "sleight 1.6.0", action: nil, keyEquivalent: ""))
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
enum HandFrame { case edge(String, EdgeChipMessage), pause(String, String, String, Bool), clear(String, String), activity(String), call(String), picker(String, CursorPickerMessage), narrationCheck(String, String), character(String, SpriteFrame), act(String, HandAct), aim(String, RingEvent), status(String, RingEvent), hide(String), menu(String, enabled: Bool, capture: String, version: String, permissions: PermissionsData?, usage: UsageStats?) }
let handKinds: Set<String> = ["click", "double", "right", "key", "type", "drag", "scroll"]
func handSequenceFresh(_ seq: Int, after last: Int) -> Bool { seq > last }
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
    if data["hand"] as? String == "edge" { return EdgeChipMessage.parse(data).map { .edge(nonce, $0) } }
    guard honestFieldsValid(data) else { return nil }
    if data["hand"] as? String == "pause-ack" {
        guard Set(data.keys) == ["hand", "nonce", "phase", "token", "paused"],
            let phase = data["phase"] as? String, ["ready", "applied", "restore", "aborted"].contains(phase),
            let token = data["token"] as? String, token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
            let value = data["paused"] as? Bool else { return nil }
        return .pause(nonce, phase, token, value)
    }
    if data["hand"] as? String == "clear" {
        guard Set(data.keys).subtracting(["keepStage", "placed", "placementSeq"]) == ["hand", "nonce", "token"],
            data["keepStage"] == nil || (data["keepStage"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() }) == true,
            data["placed"] == nil || (data["placed"] as? NSNumber).map({ CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue }) == true,
            data["placed"] == nil ? data["placementSeq"] == nil : integer(data["placementSeq"], 0...9007199254740991) != nil,
            let token = data["token"] as? String,
            token.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }
        return .clear(nonce, token)
    }
    if data["hand"] as? String == "activity" { return Set(data.keys) == ["hand", "nonce"] ? .activity(nonce) : nil }
    if data["hand"] as? String == "call" { return Set(data.keys) == ["hand", "nonce"] ? .call(nonce) : nil }
    if data["hand"] as? String == "picker" { return CursorPickerMessage.parse(data).map { .picker(nonce, $0) } }
    if data["hand"] as? String == "narration-check" {
        guard Set(data.keys) == ["hand", "nonce", "token"], let token = data["token"] as? String,
            token.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { return nil }
        return .narrationCheck(nonce, token)
    }
    if data["hand"] as? String == "character" { return spriteFrame(data).map { .character(nonce, $0) } }
    if data["hand"] as? String == "hide" {
        return Set(data.keys).subtracting(["reason"]) == ["hand", "nonce"] &&
            (data["reason"] == nil || data["reason"] as? String == "unknown-app") ? .hide(nonce) : nil
    }
    if data["hand"] as? String == "menu" {
        let keys: Set<String> = ["hand", "nonce", "enabled", "capture", "version"]
        guard keys.isSubset(of: Set(data.keys)), Set(data.keys).subtracting(keys).isSubset(of: ["permissions", "usage", "narration", "voice"]), NarrationOptions.parse(data) != nil,
            let enabled = data["enabled"] as? NSNumber, CFGetTypeID(enabled) == CFBooleanGetTypeID(),
            let capture = data["capture"] as? String, ["hidden", "visible"].contains(capture),
            let version = data["version"] as? String, version.range(of: #"^\d{1,3}\.\d{1,3}\.\d{1,3}$"#, options: .regularExpression) != nil
            else { return nil }
        let permissions = data["permissions"].map { permissionsData($0) }
        if let parsed = permissions, parsed == nil { return nil }
        return .menu(nonce, enabled: enabled.boolValue, capture: capture, version: version, permissions: permissions ?? nil, usage: usageData(data["usage"]))
    }
    if data["hand"] as? String == "wide" {
        let keys = Set(data.keys)
        guard keys.isSuperset(of: ["hand", "nonce", "seq", "reason", "epoch"]),
            keys.isSubset(of: ["hand", "nonce", "seq", "reason", "epoch", "pid", "windowId", "app"]),
            let seq = integer(data["seq"], 0...9007199254740991), let epoch = integer(data["epoch"], 0...9007199254740991),
            let reason = data["reason"] as? String, ["read", "unlocated", "scroll", "drag", "acquisition"].contains(reason),
            data["pid"] == nil || integer(data["pid"], 1...2147483647) != nil,
            data["windowId"] == nil || data["pid"] != nil && integer(data["windowId"], 1...4294967295) != nil else { return nil }
        let name = data["app"] as? String
        if data["app"] != nil {
            guard let name = name, !name.isEmpty, name.utf16.count <= 160,
                !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || CharacterSet.illegalCharacters.contains($0) || [0x2028, 0x2029].contains($0.value) }),
                data["pid"] == nil else { return nil }
        }
        guard data["pid"] != nil || name != nil else { return nil }
        var event = RingEvent(seq: seq, state: "thinking", pid: Int32(integer(data["pid"], 1...2147483647) ?? 0),
            windowId: UInt32(integer(data["windowId"], 1...4294967295) ?? 0), at: nil, rect: nil, label: nil)
        event.area = event.windowId > 0 ? "window" : "app"
        event.wideName = name; event.wideReason = reason; event.wideEpoch = epoch
        return .status(nonce, event)
    }
    if let tag = data["hand"] as? String, ["aim", "status"].contains(tag) {
        let keys: Set<String> = tag == "aim" ? ["hand", "nonce", "seq", "kind", "pid", "windowId", "at"] : ["hand", "nonce", "seq", "state", "pid", "windowId"]
        let optional: Set<String> = tag == "aim" ? ["rect", "holdMs", "label", "say", "retry", "transfer", "windowRect"] : ["at", "ok", "say", "detail", "windowRect", "area"]
        let area = data["area"] as? String
        guard data["area"] == nil || tag == "status" && ["window", "app"].contains(area ?? "") && data["at"] == nil else { return nil }
        guard keys.isSubset(of: Set(data.keys)), Set(data.keys).subtracting(keys).isSubset(of: optional),
            data["say"] == nil || (data["say"] as? String).map({ $0.utf8.count <= 1024 }) == true,
            data["ok"] == nil || (data["state"] as? String == "done" && (data["ok"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() } == true),
            let seq = integer(data["seq"], 0...9007199254740991),
            let pid = integer(data["pid"], 1...2147483647), let window = integer(data["windowId"], (area == "app" ? 0 : 1)...4294967295),
            data["at"] == nil || point(data["at"]) != nil,
            data["label"] == nil || data["label"] is String else { return nil }
        guard let rect = rectValue(data["rect"]), let windowRect = rectValue(data["windowRect"]) else { return nil }
        let state: String
        if tag == "aim" {
            guard let kind = data["kind"] as? String, handKinds.contains(kind),
                data["holdMs"] == nil || integer(data["holdMs"], 0...600) != nil else { return nil }
            state = "aim"
        } else {
            guard let value = data["state"] as? String, ["waiting", "error", "done", "handback", "thinking", "paused"].contains(value) else { return nil }
            state = value
        }
        var event = RingEvent(seq: seq, state: state, pid: Int32(pid), windowId: UInt32(window), at: point(data["at"]), rect: rect,
            label: handLabel(data["label"]), say: narrationText(data["say"]), holdMs: integer(data["holdMs"], 0...600) ?? 0, ok: (data["ok"] as? NSNumber)?.boolValue ?? false, detail: data["detail"] as? String, retry: data["retry"] as? Bool ?? false, transfer: data["transfer"] as? String)
        event.windowRect = windowRect
        event.area = area
        return tag == "aim" ? .aim(nonce, event) : .status(nonce, event)
    }
    let actKeys: Set<String> = ["hand", "nonce", "seq", "kind", "pid", "windowId", "at", "path", "delayMs", "beats"]
    guard data["hand"] as? String == "act", actKeys.isSubset(of: Set(data.keys)),
        Set(data.keys).subtracting(actKeys).isSubset(of: ["label", "rect", "caretX", "say", "retry", "transfer", "windowRect"]),
        data["say"] == nil || (data["say"] as? String).map({ $0.utf8.count <= 1024 }) == true, data["label"] == nil || data["label"] is String,
        let rect = rectValue(data["rect"]), let windowRect = rectValue(data["windowRect"]), data["caretX"] == nil || ((data["kind"] as? String).map { ["type", "key"].contains($0) } == true
            && number(data["caretX"]).map { abs($0) <= 100000 } == true),
        let seq = integer(data["seq"], 0...9007199254740991), let kind = data["kind"] as? String, handKinds.contains(kind),
        let pid = integer(data["pid"], 1...2147483647), let windowId = integer(data["windowId"], 1...4294967295),
        let at = point(data["at"]), let raw = data["path"] as? [Any], (1...64).contains(raw.count),
        let delay = integer(data["delayMs"], 0...10000), let beats = integer(data["beats"], 1...20) else { return nil }
    let path = raw.compactMap(point)
    guard path.count == raw.count else { return nil }
    return .act(nonce, HandAct(seq: seq, kind: kind, pid: Int32(pid), windowId: UInt32(windowId), at: at, path: path,
        delay: Double(delay) / 1000, beats: beats, label: handLabel(data["label"]), say: narrationText(data["say"]), windowRect: windowRect, rect: rect, caretX: number(data["caretX"]), retry: data["retry"] as? Bool ?? false, transfer: data["transfer"] as? String))
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
    var grab: CGPoint? = nil
    var sprite: SpritePlan? = nil
    var bubble: NarrationBubble? = nil, oldBubble: NarrationBubble? = nil
    var layers: [RingLayer] = [], tracks: [RingTrack] = []
    var total = 0.0, glide = 0.0, glideEnd = 0.0, fade = 0.22
    var dropped = false
    var label: String?, rect: CGRect?, oldLabel: String?, chip: RingChip?
    var points: [CGPoint] = [], positions: [(Double, CGPoint)] = [], shape: [String: Double] = [:]
    var phases: [String: [Double]] = [:], timers: [RingTimer] = [], budget: [String: Double] = [:]
    var entrance: String?, variation: Double?
    var detail: String? = nil, retry = false, transfer: String? = nil
    var windowRect: CGRect? = nil
    var seq = 0
    var producer: StageProducerIdentity? = nil
    var pid: Int32 = 0, window: UInt32 = 0, ok = false   // the drawn frame's window and done result, for perch mode
    var protectsTarget = true
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
        ["state": state, "at": [at.x, at.y], "bubble": bubble?.json as Any? ?? NSNull(), "layers": layers.map { $0.json }, "animations": tracks.map { $0.json }, "total": total,
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
        case "paused": tl.to([.o: 1, .hol: 1, .sp: 0, .px: 0, .fray: 0], t, 0.12)
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
        p.grab = event.state == "drag" ? event.path.first ?? event.at : nil
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
        if event.state == "paused" { p.timers = [RingTimer(at: total, action: "park")] }
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
        windowRect: act.windowRect, say: act.say, path: act.path, beats: act.beats, caretX: act.caretX, retry: act.retry, transfer: act.transfer)
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
    var narration = NarrationOptions()
    init(theme: RingTheme, seed: UInt64) { self.theme = theme; self.seed = seed }
    var idle: Bool { pending.isEmpty && timers.isEmpty && !shown }
    var next: Double? { (pending.map { $0.due } + timers.map { $0.at }).min() }
    mutating func receive(_ event: RingEvent, delay: Double, now: Double, _ env: RingEnvironment) -> [(Double, RingEffect)] {
        var out = advance(to: now, env)
        let terminal = ["error", "done", "handback", "paused"].contains(event.state)
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
        let frameOk = event.ok, measuredWindow = event.windowRect, producer = event.producer, protectsTarget = event.at != nil || event.windowRect != nil, (event, palm) = perchDissolve(event, .null, dissolveAt)
        let known = session.pid == event.pid && session.window == event.windowId && session.point != nil
        guard event.at != nil || known else { return [(now, .drop(event.state))] }
        // A repeat of the state the ring already shows at the same point, inside that plan, changes nothing.
        if known, ["thinking", "waiting", "error", "done", "handback", "paused"].contains(event.state), let last = session.previous, last.state == event.state, event.at == nil || event.at == last.at,
            frameOk == last.ok, measuredWindow == last.windowRect, event.detail == last.detail, event.label == last.label, narrationText(event.say) == last.bubble?.spoken, now - session.began < last.total { return [] }
        guard let bounds = env.bounds(event.pid, event.windowId) else { return hide(now) }
        let clip = palm.isNull ? bounds : bounds.union(palm)
        let previousBubble = known ? session.previous?.bubble : nil
        var plan = session.plan(event, theme: theme, now: now, reduced: env.reduced(), secure: env.secure(), clip: clip, seed: seed)
        guard !plan.dropped else { return [(now, .drop(event.state))] }
        plan.detail = event.detail; plan.retry = event.retry; plan.transfer = event.transfer
        plan.windowRect = measuredWindow
        plan.seq = event.seq; plan.pid = event.pid; plan.window = event.windowId; plan.ok = frameOk
        plan.producer = producer
        plan.protectsTarget = protectsTarget
        if let character = character { plan.sprite = SpritePlan.make(plan, character: character, reduced: env.reduced(), secure: env.secure(), clip: clip) }
        NarrationBubble.attach(&plan, say: event.say, clip: clip, secure: env.secure(), options: narration,
            previous: previousBubble, reduced: env.reduced(), ink: theme.ink)
        session.previous = plan
        let oldBubble = plan.oldBubble.map { [$0.frame.origin, CGPoint(x: $0.frame.maxX, y: $0.frame.maxY)] } ?? []
        let bubble = plan.bubble.map { [$0.frame.origin, CGPoint(x: $0.frame.maxX, y: $0.frame.maxY + ($0.tail == "down" ? 5 : 0)),
            CGPoint(x: $0.frame.minX, y: $0.frame.minY - ($0.tail == "up" ? 5 : 0))] } ?? []
        let chip = plan.chip.map { [$0.frame.origin, CGPoint(x: $0.frame.maxX, y: $0.frame.maxY)] } ?? []
        var frame = handBox(plan.points + [plan.at] + chip + bubble + oldBubble)
        if let sprite = plan.sprite { frame = frame.union(sprite.bounds(plan)) }
        if plan.bubble == nil { frame = frame.intersection(clip) }
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
struct SpriteEntry: Equatable {
    let sheet: String, row: Int, columns: [Int], ms: [Double], loop: Bool, flip: Bool, hotspot: CGPoint
    let size: CGSize?, scale: Double, then: String?
}
struct SpriteFrame {
    let seq: Int, id: String, sheet: String, extra: String?, cell: CGSize, table: [String: SpriteEntry]
    var perch: PerchTable? = nil, perchSheet: String? = nil, lines: PerchLineSet? = nil
    var stage: [String: SpriteStageEntry]? = nil
    var stageOptions = StageOptions()
    var sessionBadge: String? = nil
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
    guard Set(data.keys).subtracting(["perch", "perchSheet", "lines", "stage", "size", "stageAttention", "stageFrontSit", "sessionBadge"]) == ["hand", "nonce", "seq", "id", "sheet", "extra", "cell", "table"],
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
    guard let stageOptions = StageOptions.parse(data), let extras = perchFrameExtras(data, cell: CGSize(width: cell[0], height: cell[1]), extra: path(data["extra"]) != nil) else { return nil }
    var frame = SpriteFrame(seq: seq, id: id, sheet: sheet, extra: path(data["extra"]), cell: CGSize(width: cell[0], height: cell[1]), table: table,
        perch: extras.table, perchSheet: extras.sheet, lines: extras.lines, stageOptions: stageOptions)
    if let raw = data["sessionBadge"] {
        guard let badge = raw as? String, badge.range(of: "^[A-Z]$", options: .regularExpression) != nil else { return nil }
        frame.sessionBadge = badge
    }
    if let raw = data["stage"] {
        guard let stage = spriteStageFrame(raw, frame: frame) else { return nil }; frame.stage = stage
    }
    return frame
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
// BEGIN SPRITE REAP
final class SpriteExitEvent {
    let queue: Int32, registered: Bool
    init(_ pid: pid_t) {
        queue = kqueue()
        guard queue >= 0 else { registered = false; return }
        _ = fcntl(queue, F_SETFD, FD_CLOEXEC)
        var change = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT),
            fflags: UInt32(NOTE_EXIT), data: 0, udata: nil)
        registered = kevent(queue, &change, 1, nil, 0, nil) == 0
    }
    deinit { if queue >= 0 { close(queue) } }
}
// The child starts suspended, so the exit event is armed before it can enter
// exit teardown (EV_ADD can return ESRCH before waitpid can collect that exit).
// waitpid is only the collector. The post-EOF event wait retains its 0.5 s bound.
func spriteReap(_ pid: pid_t, wait: Bool, event: SpriteExitEvent) -> (reaped: Bool, status: Int32) {
    var status: Int32 = 0, reaped = false
    if wait {
        if event.registered {
            let deadline = ProcessInfo.processInfo.systemUptime + 0.5
            while true {
                let result = waitpid(pid, &status, WNOHANG)
                if result == pid { reaped = true; break }
                if result < 0 { if errno == EINTR && ProcessInfo.processInfo.systemUptime < deadline { continue }; break }
                let left = deadline - ProcessInfo.processInfo.systemUptime
                guard left > 0 else { break }
                var timeout = timespec(tv_sec: Int(left), tv_nsec: Int((left - floor(left)) * 1_000_000_000))
                var notification = kevent()
                let ready = kevent(event.queue, nil, 0, &notification, 1, &timeout)
                if ready < 0 && errno == EINTR { continue }
                guard ready > 0, notification.flags & UInt16(EV_ERROR) == 0 else { break }
                // NOTE_EXIT is one-shot. Collection after delivery cannot need polling.
                var collected: pid_t
                repeat { collected = waitpid(pid, &status, 0) } while collected < 0 && errno == EINTR
                reaped = collected == pid; break
            }
        }
    }
    if !reaped { kill(pid, SIGKILL); while waitpid(pid, &status, 0) < 0 && errno == EINTR {} }
    return (reaped, status)
}
// END SPRITE REAP
final class SpriteDecodeTelemetry {
    var parts: [String: Double] = [:]
    func record(_ key: String, since start: Double) { parts[key] = (ProcessInfo.processInfo.systemUptime - start) * 1000 }
}
// Runs `--decode-sheet` on the open file and reads exactly w*h*4 bytes within 2 s. The child gets the file as stdin, a pipe
// as stdout and /dev/null as stderr; POSIX_SPAWN_CLOEXEC_DEFAULT keeps every other descriptor (the consent channel's fds 3
// and 4 among them) out of it. The returned buffer is malloc'd; the caller owns it.
func spriteDecodeInChild(fd: Int32, width: Int, height: Int, format: String, cancelled: () -> Bool = { false }, telemetry: SpriteDecodeTelemetry? = nil) throws -> UnsafeMutableRawPointer {
    let spawnBegan = ProcessInfo.processInfo.systemUptime
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
    posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_START_SUSPENDED))
    let argv = [executable, "--decode-sheet", String(width), String(height), format].map { strdup($0) } + [nil]
    defer { argv.forEach { free($0) } }
    var pid: pid_t = 0
    let spawned = posix_spawn(&pid, executable, &actions, &attributes, argv, environ)
    close(pipeEnds[1])
    guard spawned == 0 else { throw SpriteLoadError.child }
    guard spriteTrack(pid) else {
        kill(pid, SIGKILL); var s: Int32 = 0; while waitpid(pid, &s, 0) < 0 && errno == EINTR {}; throw SpriteLoadError.child
    }
    let exitEvent = SpriteExitEvent(pid)
    guard exitEvent.registered, let buffer = malloc(width * height * 4) else {
        kill(pid, SIGKILL); var s: Int32 = 0; while waitpid(pid, &s, 0) < 0 && errno == EINTR {}; spriteUntrack(pid); throw SpriteLoadError.child
    }
    guard kill(pid, SIGCONT) == 0 else {
        _ = spriteReap(pid, wait: false, event: exitEvent); spriteUntrack(pid); free(buffer); throw SpriteLoadError.child
    }
    telemetry?.record("spawnMs", since: spawnBegan)
    let transferBegan = ProcessInfo.processInfo.systemUptime
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
    telemetry?.record("transferMs", since: transferBegan)
    let reapBegan = ProcessInfo.processInfo.systemUptime
    let (reaped, status) = spriteReap(pid, wait: !(timedOut || extra || stopped), event: exitEvent)
    // After the reap, never at function end, so a reused pid is never signalled.
    spriteUntrack(pid)
    telemetry?.record("reapMs", since: reapBegan)
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
// BEGIN BUILTIN CHARACTER HASHES
let spriteBuiltinHashes: [String: [String: String]] = [
    "tsugi": [
        "extra.webp": "e538b83ae608fc13f59dc3dcd6c22f1c1376df59d1f8db39cad856ef61293999",
        "perch.webp": "3e8a9a8d66791c23abf0ad812d351bb2c5db68bbb2a7e7a7008ae83ebac8b52e",
        "sheet.webp": "e0b6d9ca9be79686569b3ba2601528a79c5cf6e8ed91d5421f8af2c71e9b9d24"
    ],
    "shizu": [
        "extra.webp": "b490ed6078ddf36135f5866c2b87a318194b1393cf2822a1d3a7a94865e015f4",
        "perch.webp": "89fe50a8869ef66269463f0fb0e331f0ea59c7a5398e334006b7a1f0aa1526c5",
        "sheet.webp": "eb3a547b7b6a58ef3cf3728be7a4f798163765c31dd3775afa76a59eea36f9b2"
    ],
    "bit": [
        "extra.webp": "e0d78aa8ed60f975e156a923cec7ae940aed5edb05ca416dcf4fdfad4bb26f64",
        "perch.webp": "cf5ac17a50422168677a4f12d8f74eb6e32f434605dfb6feb1ee739344581af6",
        "sheet.webp": "9081335333b74a305654c66e0d6bace4ff4afd9f94b809fac9ca78092bf882ac"
    ],
    "kit": [
        "extra.webp": "578d2027aa2a0ad21bc270427794e25a428b5892bd9d1d75d192b3241b384df8",
        "perch.webp": "c7ab4f9a4babb1b08372a4bc328fee78c812f01c549f933edbcccf7b532fe12b",
        "sheet.webp": "57ea231ac93b446316964263f4606b81acc8f224015c3ac51a40cebcadb762b4"
    ],
    "yori": [
        "extra.webp": "f1f582c2792a3bc32230fd225c0e74cad0884bfa75dd07553d47d98a9420ddf2",
        "perch.webp": "883b5378e113b14b29f7ae7be877459cb8bebf041513f4f713017b89c3e05966",
        "sheet.webp": "4cce595ceb59e0c11d9c9e96bea9f331d4a190409d50525180ceb962ffe98f4d"
    ],
    "tab": [
        "extra.webp": "11713ae8936af7b539550de17f428e005bba743a620fa170ad0d41cc61f3dd82",
        "perch.webp": "9fa4762b1fc93afcc5335329d6bc0f11bc0f1ef21620427dca76c4d1e4d532d3",
        "sheet.webp": "2d503eaa2794eef137d860ad7d2775f2d08c590948043e9ca678cc0a76d403eb"
    ],
    "mabel": [
        "extra.webp": "9d578ad6e9bff979f41840a908b480046e6f92b6047b141372d9298bf11e1bd5",
        "perch.webp": "7d37e5990c992ab59e81ceae7e65c97b38a6bc703502b2175bfe05f262fc1676",
        "sheet.webp": "c6b1781d87eec0bcc9d0698e14f1e2a6b46f1b8603939dce6d4ad693696b9111"
    ],
    "biscuit": [
        "extra.webp": "f525ec76f5332b46331b929ee91c200270b53125103df66748bf05bee1e27980",
        "perch.webp": "92bb7e76414277a95ab506f08b23f1922dc66acf3371ec5d8a78b1193640438a",
        "sheet.webp": "ae2a3ae25f068a45d672c56062c42f55d4ef404d4553ac74170907983f3ae6ce"
    ],
    "rudy": [
        "extra.webp": "b4801d2da6fab3c94fec31eceaae8aaa390fe50f03a8daa38596e083e291d88c",
        "perch.webp": "73a9fba524b017416f98e5b552da0f14eb6f2fdef49654245fde92afe0387c30",
        "sheet.webp": "859b0a4390009a79af7f47c363d1cf0ec70b9350f2ac9a8e5abe1667903eb614"
    ],
    "mo": [
        "extra.webp": "451b05afc285ca616c019b761c06aa3c6da41e5cda7071d0f7824bf918ba6f72",
        "perch.webp": "bf16c30acc098faaff33f717e85c889080da369a0056ee16712ea81f53c5d069",
        "sheet.webp": "8502e25e8f1a70ab163e9d992fb6d7b5e17a89287f7b1500b3c4f76ff8bd8daa"
    ],
    "dennis": [
        "extra.webp": "abb0de5aa718b58090c2a70456fdb395fe9190e2a8155bcc38be863f008f0e4d",
        "perch.webp": "af6aadc769230f0429dc8346e46f15fc021cc956af68bebb51d36724128e6849",
        "sheet.webp": "c54e6c36677ea79b6fc26c11b8f870a49d1d0ea7bd525d7b592c3c8d2040ca25"
    ],
    "nana": [
        "extra.webp": "5c49d2d67a131d8c0ec62bfeb33f48421093a905ba1429ca0ab22a6b0107fea4",
        "perch.webp": "82ab7f94219732e590f4f59b8e70372cbb2353b68ab78ff01000ed6bd736c514",
        "sheet.webp": "e3d3eff282fa7b51770b1c81a67a01ddd1f7786cabdcf95530e9d5933f6025d6"
    ],
    "hal": [
        "extra.webp": "bc2eaf3f740c4c30506ad5759ffd82d3e16fb1de518c0d0ae6e7e987b8e9efad",
        "perch.webp": "fb1b5c9a40b19c2b63f4f75fd23a29299efc462ae2793e52a5d3ce1540c5f87a",
        "sheet.webp": "d5e7b54c1abf8543112816dbaae78c70ca377aefcdb891bdccd269704eb51874"
    ]
]
// END BUILTIN CHARACTER HASHES
struct SpriteCharacter {
    let frame: SpriteFrame, images: [String: CGImage]
    let stage: SpriteStageCache
    var ink: [String: CGRect] = [:]
    struct Result { let character: SpriteCharacter?, reason: String?, warnings: [String] }
    static func stageRoot() -> String {
        let env = ProcessInfo.processInfo.environment
        // Only no-window dumps can redirect the stage bank into an owned temporary fixture.
        if env["SLEIGHT_CURSOR_TEST"] == "1", CommandLine.arguments.contains("--stage-cache-dump"),
            let p = env["SLEIGHT_CURSOR_STAGE_ROOT"], p.hasPrefix("/private/tmp/") { return p }
        return NSHomeDirectory() + "/Library/Application Support/sleight/character-stage"
    }
    static func root() -> String {
        // The no-window sharing check can read only an owned private temporary bank. Live rendering never takes this path.
        let args = CommandLine.arguments
        if args.count == 3, args[1] == "--check-character" {
            let path = args[2], parent = (path as NSString).deletingLastPathComponent
            let leaf = (path as NSString).lastPathComponent
            var st = stat(), bytes = [CChar](repeating: 0, count: Int(PATH_MAX))
            if parent == "/private/tmp", leaf.range(of: "^sleight-character-check-[A-Za-z0-9]{6}$", options: .regularExpression) != nil,
               realpath(path, &bytes) != nil, String(cString: bytes) == path,
               lstat(path, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid(), st.st_mode & 0o7777 == 0o700 {
                return path
            }
            return "/invalid-character-check-root"
        }
        let env = ProcessInfo.processInfo.environment
        if env["SLEIGHT_CURSOR_TEST"] == "1", let p = env["SLEIGHT_CURSOR_CHARACTERS_ROOT"], p.hasPrefix("/private/tmp/") { return p }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/sleight/characters").path
    }
    // Every check, with no output. The extra sheet loads only when a table entry uses it.
    static func check(_ frame: SpriteFrame, validateStage: Bool = false, cancelled: @escaping () -> Bool = { false }) -> Result {
        do {
            var images: [String: CGImage] = [:], ink: [String: CGRect] = [:], warnings = Set<String>()
            let used = Set(frame.allEntries.map { $0.sheet })
            for (key, path) in [("sheet", Optional(frame.sheet)), ("extra", frame.extra), ("perch", frame.perchSheet)] {
                guard let path = path, used.contains(key) else { continue }
                guard !cancelled() else { throw SpriteLoadError.cancelled }
                let loaded = try decode(path, key: key, frame: frame, cancelled: cancelled)
                images[key] = loaded.0; warnings.formUnion(loaded.1); ink[key] = loaded.2
            }
            if validateStage {
                var checked = Set<String>()
                for entry in (frame.stage ?? [:]).sorted(by: { $0.key < $1.key }).map({ $0.value }) {
                    guard let file = entry.file, checked.insert(file).inserted else { continue }
                    // Release each strip before checking the next. Import checks never fill the live cache.
                    warnings.formUnion(try decode(file, key: file, frame: frame, stage: entry, cancelled: cancelled).1)
                }
            }
            return Result(character: SpriteCharacter(frame: frame, images: images, stage: SpriteStageCache(frame: frame), ink: ink), reason: nil, warnings: warnings.sorted())
        } catch { return Result(character: nil, reason: (error as? SpriteLoadError)?.rawValue ?? "decode", warnings: []) }
    }
    // check plus one stderr line (a trace for the dump and direct runs; the relay reads the stdout event instead).
    static func load(_ frame: SpriteFrame, cancelled: @escaping () -> Bool = { false }) -> Result {
        let result = check(frame, cancelled: cancelled)
        if !cancelled() && frame.stageOptions.size == "stage" { result.character?.stage.warm() }
        if result.reason == SpriteLoadError.cancelled.rawValue { return result }
        if let reason = result.reason { spriteWarning("character refused (\(reason)); using ring") }
        else if !result.warnings.isEmpty { spriteWarning(result.warnings.joined(separator: ", ") + " (warning)") }
        return result
    }
    static func decode(_ path: String, key: String, frame: SpriteFrame, stage: SpriteStageEntry? = nil, cancelled: @escaping () -> Bool = { false }, telemetry: SpriteDecodeTelemetry? = nil) throws -> (CGImage, Set<String>, CGRect) {
        let validationBegan = ProcessInfo.processInfo.systemUptime
        // The launcher supplies this fixed package path in its sanitized environment. Frames cannot add roots.
        let sharingCheck = CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--check-character"
        let builtin = !sharingCheck && spriteBuiltinHashes[frame.id] != nil
        let packageRoot = ProcessInfo.processInfo.environment["SLEIGHT_BUILTIN_CHARACTERS"] ?? ""
        let cachedStage = builtin && stage?.cacheKey != nil
        let root = cachedStage ? stageRoot() : builtin ? packageRoot : root()
        let characterParent = root + "/" + frame.id
        let expectedParent = cachedStage ? characterParent + "/" + stage!.cacheKey! : characterParent
        guard root.hasPrefix("/") else { throw SpriteLoadError.path }
        func canonical(_ path: String) -> Bool {
            var bytes = [CChar](repeating: 0, count: Int(PATH_MAX))
            return realpath(path, &bytes) != nil && String(cString: bytes) == path
        }
        let parent = stage == nil ? expectedParent : expectedParent + "/stage"
        guard canonical(path), canonical(root),
            (path as NSString).deletingLastPathComponent == parent else { throw SpriteLoadError.path }
        // Check every directory within the private character bank, not just the leaf filename.
        for directory in Set([root, characterParent, expectedParent, parent]) {
            var st = stat()
            guard lstat(directory, &st) == 0, st.st_mode & S_IFMT == S_IFDIR, st.st_uid == getuid(), st.st_mode & 0o7022 == 0,
                !cachedStage || st.st_mode & 0o7777 == 0o700 else { throw SpriteLoadError.permissions }
        }
        // Match character.mjs: 0600 plus the 0644 data mode measured in both plugin caches.
        var before = stat()
        guard lstat(path, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_uid == getuid(),
            ((before.st_mode & 0o7777) == 0o600 || builtin && !cachedStage && (before.st_mode & 0o7777) == 0o644), before.st_nlink == 1 else { throw SpriteLoadError.permissions }
        guard before.st_size > 0, before.st_size <= (stage == nil ? 8 : 4) * 1024 * 1024 else { throw SpriteLoadError.size }
        // O_NOFOLLOW_ANY (which can't be combined with O_NOFOLLOW: EINVAL) refuses a symlink in any component, so a directory swapped after the realpath check can't redirect
        // the open; F_GETPATH confirms the descriptor is the checked path.
        let fd = open(path, O_RDONLY | O_NOFOLLOW_ANY | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else { throw SpriteLoadError.path }; defer { close(fd) }
        var opened = stat(), name = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(fd, F_GETPATH, &name) == 0, String(cString: name) == path else { throw SpriteLoadError.path }
        guard fstat(fd, &opened) == 0, opened.st_dev == before.st_dev, opened.st_ino == before.st_ino,
            opened.st_mode == before.st_mode, opened.st_uid == before.st_uid, opened.st_size == before.st_size else { throw SpriteLoadError.changed }
        if builtin {
            var bytes = [UInt8](repeating: 0, count: Int(opened.st_size))
            let relative = stage == nil ? (path as NSString).lastPathComponent : "stage/" + (path as NSString).lastPathComponent
            guard let pin = cachedStage ? stage?.sha256 : spriteBuiltinHashes[frame.id]?[relative],
                pread(fd, &bytes, bytes.count, 0) == bytes.count,
                SHA256.hash(data: Data(bytes)).map({ String(format: "%02x", $0) }).joined() == pin else { throw SpriteLoadError.changed }
        }
        var head = [UInt8](repeating: 0, count: 64)
        let headCount = pread(fd, &head, 64, 0)
        guard headCount > 0, let header = spriteSheetHeader(Array(head.prefix(headCount))) else { throw SpriteLoadError.type }
        guard (path as NSString).pathExtension.lowercased() == header.format else { throw SpriteLoadError.type }
        let w = header.width, h = header.height
        let cell = stage?.cell ?? frame.cell, columns = stage?.columns.count ?? 8
        let entries: [SpriteEntry]
        if let stage = stage {
            guard w == Int(cell.width) * columns, h == Int(cell.height), w <= 4096, h <= 1024 else { throw SpriteLoadError.size }
            var bytes = [UInt8](repeating: 0, count: Int(opened.st_size))
            guard pread(fd, &bytes, bytes.count, 0) == bytes.count, spriteStageContainer(bytes, format: header.format) else { throw SpriteLoadError.type }
            entries = [stage.art]
        } else {
            guard w > 0, h > 0, w <= spriteSheetCap.width, h <= spriteSheetCap.height, w == Int(cell.width) * 8,
                h % Int(cell.height) == 0 else { throw SpriteLoadError.size }
            entries = frame.allEntries.filter { $0.sheet == key }
            guard entries.allSatisfy({ ($0.row + 1) * Int(cell.height) <= h && ($0.size == nil || $0.size == CGSize(width: w, height: h)) }) else { throw SpriteLoadError.size }
        }
        telemetry?.record("validationMs", since: validationBegan)
        let buffer = try spriteDecodeInChild(fd: fd, width: w, height: h, format: header.format, cancelled: cancelled, telemetry: telemetry)
        let imageBegan = ProcessInfo.processInfo.systemUptime
        // The image wraps the child's bytes without a copy and frees them when it goes (replacement, style change or exit).
        guard let provider = CGDataProvider(dataInfo: nil, data: buffer, size: w * h * 4, releaseData: { _, data, _ in free(UnsafeMutableRawPointer(mutating: data)) }) else {
            free(buffer); throw SpriteLoadError.decode
        }
        let pixels = buffer.assumingMemoryBound(to: UInt8.self)
        let scanBegan = ProcessInfo.processInfo.systemUptime
        var ink = CGRect.null
        var used = Set<Int>(), rows = Set<Int>(), warnings = Set<String>()
        for entry in entries { rows.insert(entry.row); for col in entry.columns { used.insert(entry.row * columns + col) } }
        let cw = Int(cell.width), ch = Int(cell.height)
        for row in rows {
            for col in 0..<columns {
                var visible = 0, opaque = 0, green = 0
                var minX = cw, minY = ch, maxX = -1, maxY = -1
                for y in row * ch..<(row + 1) * ch {
                    for x in col * cw..<(col + 1) * cw {
                        let p = (y * w + x) * 4, a = pixels[p + 3]
                        if a > 0 {
                            visible += 1
                            minX = min(minX, x - col * cw); maxX = max(maxX, x - col * cw)
                            minY = min(minY, y - row * ch); maxY = max(maxY, y - row * ch)
                        }
                        if a == 255 { opaque += 1 }
                        if a > 0, pixels[p + 1] > 100, Int(pixels[p + 1]) > Int(pixels[p]) * 2, Int(pixels[p + 1]) > Int(pixels[p + 2]) * 2 { green += 1 }
                    }
                }
                if used.contains(row * columns + col) {
                    guard visible >= 50, Double(opaque) < Double(cw * ch) * 0.95 else { throw SpriteLoadError.pixels }
                    ink = ink.union(CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
                    if green > 0 { warnings.insert("chroma fringe") }
                } else if visible > 0, !(row == 0 && col == 6) { // Codex v2 permits its optional neutral look pose here.
                    // The host sees only resolved columns, not each row's declared frame count, so this is a warning.
                    warnings.insert("ink in an unused cell")
                }
            }
        }
        telemetry?.record("scanMs", since: scanBegan)
        let scanEnded = ProcessInfo.processInfo.systemUptime
        var after = stat()
        guard fstat(fd, &after) == 0, after.st_size == opened.st_size,
            after.st_mtimespec.tv_sec == opened.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == opened.st_mtimespec.tv_nsec,
            after.st_ctimespec.tv_sec == opened.st_ctimespec.tv_sec, after.st_ctimespec.tv_nsec == opened.st_ctimespec.tv_nsec else { throw SpriteLoadError.changed }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
            let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: space,
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { throw SpriteLoadError.decode }
        telemetry?.parts["imageMs"] = ((scanBegan - imageBegan) + (ProcessInfo.processInfo.systemUptime - scanEnded)) * 1000
        return (image, warnings, ink)
    }
}
// Loads characters off the caller's thread, one at a time. Each start supersedes the load before it (its child is killed
// within 50 ms and its result dropped), and cancel() supersedes without a new load. done runs on the loader's queue, only
// for the current load; callers recheck isCurrent on their own thread before using the result.
final class SpriteLoader {
    static let queue = DispatchQueue(label: "sleight.sprite.load", qos: .userInitiated)
    private let lock = NSLock()
    private var generation = 0
    private weak var stageCache: SpriteStageCache?
    @discardableResult func start(_ frame: SpriteFrame, done: @escaping (Int, SpriteCharacter.Result) -> Void) -> Int {
        lock.lock(); generation += 1; let mine = generation; stageCache?.cancel(); stageCache = nil; lock.unlock()
        Self.queue.async {
            guard self.isCurrent(mine) else { return }
            let result = SpriteCharacter.load(frame, cancelled: { !self.isCurrent(mine) })
            self.lock.lock()
            let current = mine == self.generation
            if current { self.stageCache = result.character?.stage }
            self.lock.unlock()
            if current { done(mine, result) }
        }
        return mine
    }
    func cancel() { lock.lock(); generation += 1; stageCache?.cancel(); stageCache = nil; lock.unlock() }
    func isCurrent(_ generation: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return generation == self.generation }
}
// Stage art is optional. Live loads and draws defer decoding; import checks validate each unique strip.
let spriteStageCacheCap = 24 * 1024 * 1024
// Owner decision 5: imported pets and missing strips use medium. Change this one policy to permit upscaling.
let spriteStageFallbackAtMedium = true
let spriteStageFallbacks: [String: String] = [
    "stage-lie": "perch", "stage-lie-reach": "perch-point-right", "stage-lie-peek": "perch-peek", "stage-sleep": "sleep",
    "stage-sit": "perch", "stage-sit-notes": "perch-peek", "stage-think": "perch-peek", "stage-wait": "perch-wait", "stage-cheer": "high-five",
    "stage-hang": "perch", "stage-hang-peek": "perch-peek", "stage-climb": "running-right", "stage-stand": "idle",
    "stage-point": "aim", "stage-carry": "drag-carry", "stage-wince": "error", "stage-handoff": "handoff",
    "stage-paused": "paused", "stage-leap": "jumping", "stage-run": "running-right", "stage-startle": "startle",
]
struct SpriteStageEntry {
    let file: String?, cell: CGSize, anchor: CGPoint, filter: String, next: [String], art: SpriteEntry
    let fallback: String, fallbackArt: SpriteEntry
    var cacheKey: String? = nil, sha256: String? = nil
    var columns: [Int] { art.columns }
}
func spriteStageFrame(_ raw: Any, frame: SpriteFrame) -> [String: SpriteStageEntry]? {
    func n(_ raw: Any?, _ range: ClosedRange<Double>, integer: Bool = false) -> Double? {
        guard let v = raw as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue.isFinite,
            range.contains(v.doubleValue), !integer || v.doubleValue.rounded() == v.doubleValue else { return nil }; return v.doubleValue
    }
    func pair(_ raw: Any?, _ range: ClosedRange<Double>, integer: Bool = false) -> [Double]? {
        guard let v = raw as? [Any], v.count == 2, let x = n(v[0], range, integer: integer), let y = n(v[1], range, integer: integer) else { return nil }; return [x, y]
    }
    func bool(_ raw: Any?) -> Bool? { guard let v = raw as? NSNumber, CFGetTypeID(v) == CFBooleanGetTypeID() else { return nil }; return v.boolValue }
    guard let v = raw as? [String: Any], Set(v.keys) == (v["cache"] == nil ? ["table"] : ["table", "cache"]), let table = v["table"] as? [String: Any],
        Set(table.keys) == Set(spriteStageFallbacks.keys) else { return nil }
    let sheets = Set(["sheet"] + (frame.extra != nil ? ["extra"] : []) + (frame.perchSheet != nil ? ["perch"] : []))
    let cache = v["cache"] as? String
    if v["cache"] != nil {
        guard let key = cache, key.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
            spriteBuiltinHashes[frame.id] != nil else { return nil }
    }
    let folder = cache.map { SpriteCharacter.stageRoot() + "/" + frame.id + "/" + $0 } ?? (frame.sheet as NSString).deletingLastPathComponent
    var result: [String: SpriteStageEntry] = [:], files: [String: [Double]] = [:], pixels = 0.0
    for (name, raw) in table {
        guard let entry = raw as? [String: Any], let fallback = entry["fallback"] as? String, fallback == spriteStageFallbacks[name],
            let art = perchEntry(entry["art"], cell: frame.cell, sheets: sheets) else { return nil }
        if entry["file"] == nil {
            guard Set(entry.keys) == ["fallback", "art"] else { return nil }
            result[name] = SpriteStageEntry(file: nil, cell: frame.cell, anchor: frame.perch?.anchor ?? .zero, filter: "linear", next: [], art: art, fallback: fallback, fallbackArt: art)
            continue
        }
        let keys: Set<String> = ["fallback", "art", "file", "cell", "anchor", "hotspot", "frames", "ms", "loop", "flip", "filter", "next"]
        let pin = entry["sha256"] as? String
        guard Set(entry.keys) == (cache == nil ? keys : keys.union(["sha256"])),
            cache == nil || (pin?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil),
            let file = entry["file"] as? String, file.utf8.count <= 4096, file.hasPrefix(folder + "/stage/"),
            (file as NSString).deletingLastPathComponent == folder + "/stage",
            (file as NSString).lastPathComponent.range(of: "^[a-z-]{1,24}\\.(png|webp)$", options: .regularExpression) != nil,
            let c = pair(entry["cell"], 192...1024, integer: true), let a = pair(entry["anchor"], 0...1024), let p = pair(entry["hotspot"], 0...1024),
            a[0] <= c[0], a[1] <= c[1], p[0] <= c[0], p[1] <= c[1],
            let count = n(entry["frames"], 1...8, integer: true), count * c[0] <= 4096,
            let loop = bool(entry["loop"]), let flip = bool(entry["flip"]), let filter = entry["filter"] as? String, ["linear", "nearest"].contains(filter),
            let durations = entry["ms"] as? [Any], durations.count == Int(count),
            let next = entry["next"] as? [String], next.count <= 4, next.allSatisfy({ spriteStageFallbacks[$0] != nil }) else { return nil }
        let ms = durations.compactMap { n($0, (loop ? 40.0 : 20.0)...2000) }
        guard ms.count == durations.count, ms.reduce(0, +) <= 8000 else { return nil }
        let size = CGSize(width: count * c[0], height: c[1])
        let geometry = [c[0], c[1], count]
        if let previous = files[file] { guard previous == geometry else { return nil } }
        else { files[file] = geometry; pixels += size.width * size.height }
        guard files.count <= 24, pixels <= 24_000_000 else { return nil }
        let stageArt = SpriteEntry(sheet: file, row: 0, columns: Array(0..<Int(count)), ms: ms, loop: loop, flip: flip,
            hotspot: CGPoint(x: p[0], y: p[1]), size: size, scale: 1, then: nil)
        result[name] = SpriteStageEntry(file: file, cell: CGSize(width: c[0], height: c[1]), anchor: CGPoint(x: a[0], y: a[1]), filter: filter,
            next: next, art: stageArt, fallback: fallback, fallbackArt: art, cacheKey: cache, sha256: pin)
    }
    return result
}
// Check every chunk before ImageIO, including one-frame animation containers and bytes after the terminator.
func spriteStageContainer(_ b: [UInt8], format: String) -> Bool {
    func ascii(_ r: Range<Int>) -> String { String(decoding: b[r], as: UTF8.self) }
    func be(_ i: Int) -> Int { (0..<4).reduce(0) { ($0 << 8) | Int(b[i + $1]) } }
    func le(_ i: Int) -> Int { (0..<4).reduce(0) { $0 | Int(b[i + $1]) << (8 * $1) } }
    if format == "png" {
        var at = 8, data = false
        while at + 12 <= b.count {
            let size = be(at), kind = ascii(at + 4..<at + 8)
            guard size <= b.count - at - 12, !["acTL", "fcTL", "fdAT"].contains(kind), kind != "IHDR" || at == 8 else { return false }
            if kind == "IDAT" { data = true }
            at += 12 + size
            if kind == "IEND" { return size == 0 && data && at == b.count }
        }
        return false
    }
    guard b.count >= 30, le(4) + 8 == b.count else { return false }
    var at = 12, images = 0
    while at + 8 <= b.count {
        let size = le(at + 4), kind = ascii(at..<at + 4), start = at + 8
        guard size <= b.count - start, size + (size & 1) <= b.count - start,
            !["ANIM", "ANMF"].contains(kind), kind != "VP8X" || at == 12 && size == 10 && b[start] & 2 == 0 else { return false }
        if at == 12 && !["VP8X", "VP8 ", "VP8L"].contains(kind) { return false }
        if ["VP8 ", "VP8L"].contains(kind) { images += 1 }
        at = start + size + (size & 1)
    }
    return at == b.count && images == 1
}
struct SpriteStagePose {
    let image: CGImage, entry: SpriteEntry, cell: CGSize, anchor: CGPoint, filter: String, source: String, medium: Bool
    var pending = false
    var ink: CGRect? = nil
}
final class SpriteStageCache {
    private struct Cached { let image: CGImage, bytes: Int, ink: CGRect; var use: UInt64 }
    private let lock = NSLock(), frame: SpriteFrame
    private struct Retry { let attempts: Int, after: Double }
    private var cache: [String: Cached] = [:], pending: [String: Int] = [:], failed = Set<String>(), skipped = Set<String>()
    private var retries: [String: Retry] = [:], use: UInt64 = 0, attempts = 0
    private var active = true, protected: String?, bytes = 0, peak = 0, evictions = 0, decodes = 0, maxDecodeMs = 0.0
    private var firstDecodeMs: Double?, firstStripReadyAtMs: Double?, cacheSelects = 0, cacheHits = 0
    private var decodeSpans: [[String: Double]] = []
    private var clockOffset = 0.0, injectedFaults = Set<String>()
    init(frame: SpriteFrame) { self.frame = frame }
    // Warm complete sets when they fit. Larger packs reserve the first-seat and common mood
    // strips in priority order; the ordinary prefetch reservations never evict or exceed the cap.
    func warm() {
        var seen = Set<String>()
        var entries = (frame.stage ?? [:]).sorted { $0.key < $1.key }.compactMap { pair -> SpriteStageEntry? in
            guard let file = pair.value.file, seen.insert(file).inserted else { return nil }
            return pair.value
        }
        func cost(_ entry: SpriteStageEntry) -> Int { Int(entry.cell.width) * entry.columns.count * Int(entry.cell.height) * 4 }
        let total = entries.reduce(0) { $0 + cost($1) }
        if total > spriteStageCacheCap {
            entries.removeAll(); seen.removeAll()
            var reserved = 0
            for name in ["stage-think", "stage-wait", "stage-hang", "stage-stand", "stage-sit"] {
                guard let entry = frame.stage?[name], let file = entry.file, seen.insert(file).inserted,
                    cost(entry) <= spriteStageCacheCap - reserved else { continue }
                reserved += cost(entry); entries.append(entry)
            }
        }
        for entry in entries { request(entry, prefetch: true) }
    }
    func cancel() { lock.lock(); active = false; cache.removeAll(); bytes = 0; lock.unlock() }
    private func current() -> Bool { lock.lock(); defer { lock.unlock() }; return active }
    // Called only by the no-window dump so retry tests do not sleep or depend on host load.
    func advanceRetryClock(_ seconds: Double) { lock.lock(); clockOffset += seconds; lock.unlock() }
    var counters: [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["cacheBytes": bytes, "peakBytes": peak, "evictions": evictions, "decodes": decodes, "attempts": attempts,
            "residentStrips": cache.count, "resident2xStrips": cache.values.filter { $0.image.height == 416 }.count,
            "pending": pending.count, "failed": failed.count, "skipped": skipped.count, "retrying": retries.count, "maxDecodeMs": maxDecodeMs,
            "firstDecodeMs": firstDecodeMs as Any? ?? NSNull(), "firstStripReadyAtMs": firstStripReadyAtMs as Any? ?? NSNull(),
            "cacheSelects": cacheSelects, "cacheHits": cacheHits, "decodeSpans": decodeSpans]
    }
    // Reserve decoded bytes before queueing. Prefetch only uses free space, including pending reservations.
    private func request(_ entry: SpriteStageEntry, prefetch: Bool = false) {
        guard let file = entry.file else { return }
        let cost = Int(entry.cell.width) * entry.columns.count * Int(entry.cell.height) * 4
        lock.lock()
        guard active, cache[file] == nil, pending[file] == nil, !failed.contains(file), !skipped.contains(file),
            retries[file].map({ ProcessInfo.processInfo.systemUptime + clockOffset >= $0.after }) ?? true else { lock.unlock(); return }
        guard cost <= spriteStageCacheCap else { failed.insert(file); lock.unlock(); return }
        let reserved = pending.values.reduce(0, +)
        while bytes + reserved + cost > spriteStageCacheCap {
            guard !prefetch, let victim = cache.filter({ $0.key != protected }).min(by: { $0.value.use < $1.value.use }) else {
                skipped.insert(file); lock.unlock(); return
            }
            bytes -= victim.value.bytes; cache.removeValue(forKey: victim.key); evictions += 1
        }
        let queued = ProcessInfo.processInfo.systemUptime
        pending[file] = cost; lock.unlock()
        SpriteLoader.queue.async { [weak self] in
            guard let self = self, self.current() else { return }
            let started = ProcessInfo.processInfo.systemUptime
            let env = ProcessInfo.processInfo.environment
            let fault = env["SLEIGHT_CURSOR_TEST"] == "1" ? env["SLEIGHT_CURSOR_STAGE_DECODE_FAULT"] : nil
            self.lock.lock(); self.attempts += 1
            let inject = self.injectedFaults.insert(file).inserted
            self.lock.unlock()
            var loaded: CGImage?, failure: SpriteLoadError?, ink = CGRect.null
            let telemetry = SpriteDecodeTelemetry()
            do {
                if fault == "slow" {
                    for _ in 0..<20 { if !self.current() { break }; usleep(50_000) }
                }
                if inject && fault == "timeout-once" { throw SpriteLoadError.timeout }
                if inject && fault == "child-once" { throw SpriteLoadError.child }
                let decoded = try SpriteCharacter.decode(file, key: file, frame: self.frame, stage: entry, cancelled: { !self.current() }, telemetry: telemetry)
                loaded = decoded.0; ink = decoded.2
            } catch { failure = (error as? SpriteLoadError) ?? .decode }
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000
            self.lock.lock(); defer { self.lock.unlock() }
            self.pending.removeValue(forKey: file)
            guard self.active else { return }
            guard let image = loaded else {
                self.skipped.removeAll() // A failed reservation leaves room for other strips.
                if failure == .timeout || failure == .child {
                    let count = (self.retries[file]?.attempts ?? 0) + 1
                    let delay = min(30.0, pow(2.0, Double(min(count - 1, 5))))
                    self.retries[file] = Retry(attempts: count, after: ProcessInfo.processInfo.systemUptime + self.clockOffset + delay)
                } else if failure != .cancelled { self.failed.insert(file) }
                return
            }
            self.retries.removeValue(forKey: file)
            self.skipped.removeAll() // Completed reservations can now be evicted by a foreground request.
            self.decodes += 1; self.maxDecodeMs = max(self.maxDecodeMs, elapsed)
            if self.firstDecodeMs == nil { self.firstDecodeMs = elapsed }
            if self.firstStripReadyAtMs == nil { self.firstStripReadyAtMs = ProcessInfo.processInfo.systemUptime * 1000 }
            if self.decodeSpans.count < 64 {
                telemetry.parts["otherMs"] = max(0, elapsed - telemetry.parts.values.reduce(0, +))
                self.decodeSpans.append(["queuedMs": queued * 1000, "startedMs": started * 1000,
                    "publishedMs": ProcessInfo.processInfo.systemUptime * 1000, "queueMs": (started - queued) * 1000, "decodeMs": elapsed].merging(telemetry.parts) { $1 })
            }
            // The reservation and validated geometry account for exactly these RGBA bytes.
            guard image.bytesPerRow * image.height == cost, self.bytes + cost <= spriteStageCacheCap else { self.failed.insert(file); return }
            self.use += 1; self.cache[file] = Cached(image: image, bytes: cost, ink: ink, use: self.use)
            self.bytes += cost; self.peak = max(self.peak, self.bytes)
        }
    }
    func select(_ state: String, images: [String: CGImage], facingLeft: Bool = false) -> SpriteStagePose? {
        lock.lock(); cacheSelects += 1; lock.unlock()
        guard let fallback = spriteStageFallbacks[state] else { return nil }
        let entry = frame.stage?[state]
        let directed = facingLeft ? ["perch-point-right": "perch-point-left", "running-right": "running-left"][fallback] ?? fallback : fallback
        let art = (directed != fallback ? frame.perch?.table[directed] : nil) ?? entry?.fallbackArt ?? frame.perch?.table[fallback] ?? frame.table[fallback] ?? frame.table["idle"]!
        guard let image = images[art.sheet] else { return nil }
        if let entry = entry, let file = entry.file {
            lock.lock()
            if protected != file { skipped.removeAll() }; protected = file; use += 1
            var ready = cache[file]
            if ready != nil { ready!.use = use; cache[file] = ready; cacheHits += 1 }
            lock.unlock()
            request(entry)
            // The predecessor's first draw schedules its likely successors too, without waiting for either.
            for name in entry.next { if let next = frame.stage?[name] { request(next, prefetch: true) } }
            if let ready = ready {
                return SpriteStagePose(image: ready.image, entry: entry.art, cell: entry.cell, anchor: entry.anchor, filter: entry.filter, source: state, medium: false, ink: ready.ink)
            }
        }
        lock.lock()
        if entry?.file == nil { protected = nil; skipped.removeAll() }
        let loading = entry?.file.map { !failed.contains($0) } ?? false
        lock.unlock()
        return SpriteStagePose(image: image, entry: art, cell: frame.cell, anchor: frame.perch?.anchor ?? .zero, filter: "linear", source: directed, medium: spriteStageFallbackAtMedium, pending: loading, ink: nil)
    }
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

// BEGIN STAGE CACHE DUMP
// No NSApplication, views, layers or windows. The dump uses exactly the production selection, queue and cache.
func spriteStageCacheDump() {
    var character: SpriteCharacter?, count = 0, last = -1
    let loader = SpriteLoader()
    func emit(_ row: [String: Any]) {
        guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
    while let line = readLine() {
        guard line.utf8.count <= 32768, let bytes = line.data(using: .utf8), let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
        if data["hand"] as? String == "character" {
            guard case let .character(_, frame)? = handFrame(data), frame.seq > last else { exit(65) }; last = frame.seq
            let started = ProcessInfo.processInfo.systemUptime, loaded = DispatchSemaphore(value: 0)
            var result: SpriteCharacter.Result?
            loader.start(frame) { _, value in result = value; loaded.signal() }
            loaded.wait(); character = result?.character
            emit(["effect": "character", "loaded": character != nil, "reason": result?.reason as Any? ?? NSNull(), "cacheBytes": 0,
                "loadMs": (ProcessInfo.processInfo.systemUptime - started) * 1000])
        } else if Set(data.keys) == ["stageAwait"], data["stageAwait"] as? Bool == true {
            SpriteLoader.queue.sync {}
            guard let character = character else { exit(65) }; emit(character.stage.counters.merging(["effect": "ready"]) { $1 })
        } else if Set(data.keys) == ["stageRetryAdvance"], let seconds = data["stageRetryAdvance"] as? Double,
            seconds.isFinite, seconds >= 0, seconds <= 60, let character = character {
            character.stage.advanceRetryClock(seconds)
        } else if Set(data.keys) == ["stageState"], let state = data["stageState"] as? String, let character = character {
            let started = ProcessInfo.processInfo.systemUptime
            guard let pose = character.stage.select(state, images: character.images) else { exit(65) }
            let elapsed = (ProcessInfo.processInfo.systemUptime - started) * 1000; count += 1
            emit(character.stage.counters.merging(["effect": "stage", "state": state, "source": pose.source, "medium": pose.medium,
                "cell": [pose.cell.width, pose.cell.height], "selectMs": elapsed]) { $1 })
        } else { exit(65) }
    }
    SpriteLoader.queue.sync {}
    if let character = character { emit(character.stage.counters.merging(["effect": "end", "states": count]) { $1 }) }
}

// END STAGE CACHE DUMP
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
    guard args.count == 3, let w = Int(args[0]), let h = Int(args[1]),
        ((1...spriteSheetCap.width).contains(w) && (1...spriteSheetCap.height).contains(h) || (1...4096).contains(w) && (1...1024).contains(h)),
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
    "perch-wait", "startle", "jumping", "running-right", "running-left", "error", "handoff", "paused"]
let perchMoments = ["start", "first-click", "typing", "long-wait", "approval", "error", "done", "handback", "wake"]
struct PerchTable { let anchor: CGPoint, table: [String: SpriteEntry] }
struct PerchLineSet { let lang: String?, lines: [String: [String]] }
extension SpriteFrame {
    // Every entry the decode checks: the trail table and, with perch, the perch table (the third sheet's cells among them).
    var allEntries: [SpriteEntry] { Array(table.values) + (perch.map { Array($0.table.values) } ?? []) + (stage.map { $0.values.map { $0.fallbackArt } } ?? []) }
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
    if let raw = data["lines"] {
        // A lines block this check refuses is dropped with a warning, as the Node loader drops it: data never ends the host.
        lines = perchLineSet(raw)
        if lines == nil { spriteWarning("character lines dropped") }
    }
    return (table, sheet, lines)
}

// Geometry. All in global top-left points. The box is the cell at the pack's scale; the anchor is the seat point inside it.
// legs: how far the art below the seat line (the legs over the title bar) reaches left and right of the seat, in points:
// measured from the decoded cells (perchLegs), else the box's own extent.
struct PerchMetrics { let size: CGSize, anchor: CGPoint, scale: Double, legs: (left: Double, right: Double) }
func perchMetrics(_ frame: SpriteFrame, legs: (Double, Double)? = nil) -> PerchMetrics? {
    guard let perch = frame.perch, let e = perch.table["perch"] else { return nil }
    let size = CGSize(width: frame.cell.width * e.scale, height: frame.cell.height * e.scale), ax = Double(perch.anchor.x) * e.scale
    return PerchMetrics(size: size, anchor: CGPoint(x: ax, y: Double(perch.anchor.y) * e.scale), scale: e.scale,
        legs: legs ?? (ax, Double(size.width) - ax))
}
// Companion windows end 72 to 79 pt from the left edge on this Mac. Confirm the 80 pt bound in the first live run.
let perchCluster = 80.0, perchClusterGap = 8.0
// The leg spread: the ink at and below the seat line in every cell the perch table draws on the edge, in points left and
// right of the seat. Drawn cell by cell into a small bitmap, so no sheet's bytes are copied.
// The default set is every state drawn unmasked on the edge, standing ones (error, hand back) included; seated is the
// perch loop alone.
let perchLegStates = ["perch", "perch-hop", "perch-point-left", "perch-point-right", "sleep", "high-five", "perch-wait", "startle", "paused", "error", "handoff"]
func perchLegs(_ character: SpriteCharacter, states: [String] = perchLegStates) -> (Double, Double)? {
    let f = character.frame
    guard let perch = f.perch, let scale = perch.table["perch"]?.scale else { return nil }
    let w = Int(f.cell.width), h = Int(f.cell.height), seat = max(0, min(h, Int(perch.anchor.y.rounded(.down))))
    guard seat < h, let space = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue), let data = context.data else { return nil }
    let bytes = data.assumingMemoryBound(to: UInt8.self)
    var low = Int.max, high = Int.min
    for key in states {
        guard let e = perch.table[key], let image = character.images[e.sheet] else { continue }
        for column in Set(e.columns) {
            guard let cell = image.cropping(to: CGRect(x: column * w, y: e.row * h, width: w, height: h)) else { continue }
            context.clear(CGRect(x: 0, y: 0, width: w, height: h))
            context.draw(cell, in: CGRect(x: 0, y: 0, width: w, height: h))
            // The context's first row in memory is the image's top row.
            for y in seat..<h { for x in 0..<w where bytes[(y * w + x) * 4 + 3] > 0 { let rx = e.flip ? w - 1 - x : x; low = min(low, rx); high = max(high, rx) } }
        }
    }
    guard low <= high else { return (0, 0) }
    return ((Double(perch.anchor.x) - Double(low)) * scale, (Double(high + 1) - Double(perch.anchor.x)) * scale)
}
// The target window, the windows in front of it (the window list's order), its display and the display's usable top.
struct PerchWorld { var window: CGRect, above: [CGRect], display: CGRect, top: Double, fullScreen: Bool }
struct PerchSeat: Equatable {
    var usable: CGRect? = nil
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
func perchUsableSpans(_ world: PerchWorld) -> [(Double, Double)] {
    let need = min(96, Double(world.window.width))
    return perchSpans(world.window, above: world.above).filter { $0.1 - $0.0 >= need - 0.001 }
}
// A box wider than the span peeks at its center. Placement and cover checks use the same seat limits.
func perchSpanLimits(_ span: (Double, Double), _ m: PerchMetrics) -> (Double, Double) {
    let lo = span.0 + Double(m.anchor.x), hi = span.1 - (Double(m.size.width) - Double(m.anchor.x))
    let center = (span.0 + span.1) / 2
    return lo <= hi ? (lo, hi) : (center, center)
}
// A2's seat: on the edge nearest the target's x, legs clear of the traffic lights and the toolbar's controls, away from a
// target (and a drag's drop point) just under the edge, on the uncovered span nearest the target, and kept within 60 pt
// on the same window. Where the legs can't clear the buttons the character peeks (the edge masks them). Hidden when the
// window is gone, full screen, under 48 pt wide, under 40 pt of headroom or covered along every 96 pt.
func perchPlace(_ world: PerchWorld?, pid: Int32, window: UInt32, target: CGPoint, also: CGPoint? = nil, metrics m: PerchMetrics, previous: PerchSeat?) -> PerchPlace {
    guard let world = world else { return .hide("gone") }
    if world.fullScreen { return .hide("full-screen") }
    let win = world.window, width = Double(win.width), edge = Double(win.minY), tx = Double(target.x)
    guard width >= 48 else { return .hide("narrow") }
    let headroom = edge - world.top
    guard headroom >= 40 else { return .hide("headroom") }
    let ay = Double(m.anchor.y)
    var peek = width < 96 || headroom < ay
    let spans = perchUsableSpans(world)
    guard !spans.isEmpty else { return .hide("covered") }
    func distance(_ s: (Double, Double)) -> Double { tx >= s.0 && tx <= s.1 ? 0 : min(abs(s.0 - tx), abs(s.1 - tx)) }
    let span = spans.min { a, b in distance(a) != distance(b) ? distance(a) < distance(b) : a.1 - a.0 > b.1 - b.0 }!
    let left = Double(m.anchor.x), right = Double(m.size.width) - left
    // The left margin is 80 pt on wide windows (A2) and never less than the legs need to clear the cluster; the right one
    // steps 80, 40 and 0 with the width. The box stays on its span.
    let rightMargin = width >= 256 ? 80.0 : width >= 176 ? 40.0 : 0
    var lo = max(Double(win.minX) + (width >= 256 ? 80 : 0), Double(win.minX) + perchCluster + perchClusterGap + m.legs.left, span.0 + left)
    var hi = min(Double(win.maxX) - rightMargin, span.1 - right)
    if !peek && lo > hi { peek = true }
    if peek {
        (lo, hi) = perchSpanLimits(span, m)
    }
    let rise = peek ? min(48, ay, headroom) : ay
    func clamp(_ v: Double) -> Double { min(max(v, lo), hi) }
    // The dangling legs stay off a target (and a drop point) within 56 pt under the edge and 72 pt of the seat.
    let points = [target] + (also.map { [$0] } ?? [])
    func clear(_ x: Double) -> Bool { points.allSatisfy { p in !(Double(p.y) >= edge && Double(p.y) - edge <= 56 && abs(Double(p.x) - x) < 72 - 0.001) } }
    var x = clamp(width < 176 && !peek ? Double(win.midX) : tx)
    if !clear(x) {
        let toward = tx <= Double(win.midX) ? 1.0 : -1.0
        x = points.flatMap { p in [clamp(Double(p.x) + toward * 72), clamp(Double(p.x) - toward * 72)] }.first(where: clear) ?? x
    }
    if let p = previous, p.window == window, p.pid == pid, abs(p.x - x) <= 60, p.x >= lo - 0.001, p.x <= hi + 0.001, clear(p.x), p.peek == peek { x = p.x }
    return .seat(PerchSeat(pid: pid, window: window, x: x, edge: edge, peek: peek, rise: rise, frame: win, display: world.display, top: world.top))
}

// One plan: the box's cells, its top-left positions, opacity and peek mask over time, installed as keyframes.
struct PerchCell: Equatable { let time: Double, state: String, entry: SpriteEntry, column: Int }
struct PerchPlan {
#if SLEIGHT_STAGE_BENCH
    // A copied plan keeps its identity through a reinstall. A newly built pose gets a new identity, even if it looks equal.
    let stageBenchIdentity = UUID()
#endif
    var kind: String, seat: PerchSeat, cells: [PerchCell] = [], positions: [(Double, CGPoint)] = [], opacity: [(Double, Double)] = []
    var masked: [(Double, Bool)] = [], duration = 0.0, zs = false, zsStill = false, reduced = false, states: [String] = []
    func samePose(as other: PerchPlan) -> Bool {
        seat == other.seat && cells == other.cells && duration == other.duration && zs == other.zs &&
            zsStill == other.zsStill && reduced == other.reduced &&
            positions.elementsEqual(other.positions, by: { $0.0 == $1.0 && $0.1 == $1.1 }) &&
            opacity.elementsEqual(other.opacity, by: { $0.0 == $1.0 && $0.1 == $1.1 }) &&
            masked.elementsEqual(other.masked, by: { $0.0 == $1.0 && $0.1 == $1.1 })
    }
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
    var turnOpen = false, said: Set<String> = [], lastOk = false, startTried = false, startPending = false
    var showing: (moment: String, until: Double)?, lastAt = -Double.infinity
    var acts = 0, lastAct = Int.min / 2
    var narrationUntil = -Double.infinity, held: (moment: String, act: Bool, at: Double)?
    // C1's clear: from the relay's clear before an action that needs the pointer until its done or error, no line shows, so
    // no click panel can appear under that action (approval's waiting status included).
    var cleared = false
    static let priority: Set<String> = ["error", "approval", "handback", "done"]
    // The moment a frame is, if any. Turns end at a done without ok (the relay's turn end), a hand back or sleep. Waking
    // says wake only when the frame has no moment of its own, so a new turn still starts with its start line.
    mutating func moment(_ state: String, ok: Bool, woke: Bool) -> String? {
        if !turnOpen { turnOpen = true; said = []; lastOk = false; startTried = false; startPending = false }
        if handKinds.contains(state) { acts += 1 }
        var moment: String?
        switch state {
        case "aim": moment = !startTried && set?.lines["start"] != nil ? "start" : nil; startTried = true
        case "type": moment = said.contains("typing") ? nil : "typing"
        case "waiting": moment = "approval"
        case "error": moment = "error"; lastOk = false
        case "handback": moment = "handback"; turnOpen = false
        case "done" where ok:
            moment = startPending ? "start" : said.contains("first-click") ? nil : "first-click"
            startPending = false; lastOk = true
        case "done": moment = lastOk && !said.contains("done") ? "done" : nil; turnOpen = false
        default: break
        }
        if woke, moment == nil { moment = "wake" }
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
    // Important moments have a 3 s floor; other lines keep 8 s. Never lines on two consecutive acts,
    // never while C1's clear holds, and never with narration up: then the line waits for it.
    mutating func decide(_ moment: String, now: Double, act: Bool) -> Decision {
        guard enabled, set?.lines[moment] != nil else { return .drop }
        if cleared { if moment == "start" { startPending = true }; return .drop }
        let gap = PerchLineBook.priority.contains(moment) ? 3.0 : 8.0
        if now - lastAt < gap - 1e-9 { return .drop }
        if let s = showing, now < s.until, !PerchLineBook.priority.contains(moment) { return .drop }
        if act, acts == lastAct + 1 { return .drop }
        if now < narrationUntil { held = (moment, act, now); return .hold }
        return .show
    }
}

// Inputs from outside the runtime: the window list, motion, and text measurement (headless in the dump).
struct PerchEnvironment {
    var world: (Int32, UInt32) -> PerchWorld?
    var reduced: () -> Bool
    var measure: (String) -> CGSize
}
struct PerchWindowObservation {
    let pid: Int32, window: UInt32, expected: CGRect, observed: CGRect
    var fixture: [String: Any]? = nil
    var json: [String: Any] {
        ["pid": pid, "window": window, "expected": stageTraceRect(expected), "observed": stageTraceRect(observed),
            "differencePt": max(abs(expected.minX - observed.minX), abs(expected.minY - observed.minY),
                abs(expected.width - observed.width), abs(expected.height - observed.height)),
            "edgeDifferencePt": stageWindowEdgeDifference(expected, observed),
            "fixture": fixture as Any? ?? NSNull(), "matched": stageSameWindowBounds(expected, observed)]
    }
}
#if SLEIGHT_STAGE_BENCH
// The owned fixture supplies its own frame synchronously at the geometry decision.
var stageBenchLegacyWindowFrame: ((Int32, UInt32) -> [String: Any]?)?
#endif
enum PerchEffect { case draw(PerchPlan), reseat(CGPoint), hide(String, Double), park, still, line(PerchLine), lineOut(Double) }
// end: a drag's grab point. A drag's ring point is its drop, so the seat dodges both ends.
struct PerchEvent { let state: String, pid: Int32, window: UInt32, at: CGPoint, ok: Bool, drop: Double?, end: CGPoint?; var detail: String? = nil, retry = false, transfer: String? = nil; var windowRect: CGRect? = nil; var area: String? = nil; var wideReason: String? = nil }
// The ring's draw as a perch frame: the character reacts when the ring draws, after any act delay.
func perchEvent(_ plan: RingPlan) -> PerchEvent {
    PerchEvent(state: plan.state, pid: plan.pid, window: plan.window, at: plan.at, ok: plan.ok, drop: plan.phases["drop"]?.first,
        end: plan.state == "drag" ? plan.grab : nil, detail: plan.detail, retry: plan.retry, transfer: plan.transfer, windowRect: plan.windowRect)
}
// How long a ring plan's narration bubble (C2) stays: until the plan's fade ends or it releases.
func perchNarrationSpan(_ plan: RingPlan) -> Double {
    if let fade = plan.timers.first(where: { $0.action == "fade" }) { return fade.at + plan.fade }
    return plan.timers.first(where: { $0.action == "release" })?.at ?? plan.total + 1.2 + plan.fade
}
// The trail sprite's box, as SpritePlan.origin places it: 18 pt below and right of the point, or above or left near the
// window's far edges. Lines in trail mode anchor to it.
func perchTrailBox(_ at: CGPoint, frame: SpriteFrame, clip: CGRect) -> CGRect? {
    guard let idle = frame.table["idle"] else { return nil }
    let w = frame.cell.width * idle.scale, h = frame.cell.height * idle.scale
    let right = at.x + 18 + w <= clip.maxX, below = at.y + 18 + h <= clip.maxY
    return CGRect(x: right ? at.x + 18 : at.x - 18 - w, y: below ? at.y + 18 : at.y - 18 - h, width: w, height: h)
}
// The high-five once a turn: at the turn's end (a done without ok) after a successful last call, the ring's done burst
// plays at the palm, as a done with ok there. Each call's own done keeps its small burst at the point. The point and a
// clip that holds it (RingRuntime.dissolveAt, which the perch sets only for that frame).
func perchDissolve(_ event: RingEvent, _ clip: CGRect, _ palm: CGPoint?) -> (RingEvent, CGRect) {
    guard event.state == "done", !event.ok, let palm = palm else { return (event, clip) }
    let moved = RingEvent(seq: event.seq, state: event.state, pid: event.pid, windowId: event.windowId, at: palm, rect: nil, label: event.label, say: event.say, ok: true)
    return (moved, clip.union(CGRect(x: palm.x - 60, y: palm.y - 60, width: 120, height: 120)))
}
// The seat still fits one of the same uncovered spans placement accepts, including a wider box's centered peek.
func perchUncovered(_ seat: PerchSeat, _ world: PerchWorld, _ m: PerchMetrics) -> Bool {
    return perchUsableSpans(world).contains { span in
        let (lo, hi) = perchSpanLimits(span, m)
        return seat.x >= lo - 0.5 && seat.x <= hi + 0.5
    }
}

struct PerchRuntime {
    var frame: SpriteFrame?, seed: UInt64 = 1
    var seat: PerchSeat?, shown = false, asleep = false, paused = false, current = "perch"
    var plan: PerchPlan?, began = 0.0, lastFrame = -Double.infinity
    var timers: [(at: Double, action: String)] = []
    var reseatAnchor: CGRect?             // the window frame at the last full placement, never a silent correction
    var moving: CGRect?                  // the target window's frame while the person moves it; hidden until it holds still
    var windowObservation: PerchWindowObservation?, lastWindowMismatch: PerchWindowObservation?
    var silentReseats = 0, maxSilentReseatDifferencePt = 0.0
    var windowDecisions: [[String: Any]] = []
    var covered = false                  // hidden because a window was raised over the seat; back once it clears
    var legs: (Double, Double)?          // the measured leg spread left and right of the seat, in points
    var trail: (box: CGRect, display: CGRect, top: Double)?   // lines in trail mode anchor to the sprite's box
    var book = PerchLineBook(), line: PerchLine?
    var turnOk: Bool?            // whether the turn's last call so far succeeded (its done with ok) or failed (an error)
    var metrics: PerchMetrics? { frame.flatMap { perchMetrics($0, legs: legs) } }
    var next: Double? { timers.map { $0.at }.min() }
    // Window fallback: 250 ms while moving, 500 ms awake, 2 s asleep or once a paused animation parks.
    // Drawing and line deadlines still win. nil means nothing is perched (including after the 10 minute deep hide).
    var poll: Double? { seat == nil ? nil : moving != nil ? 0.25 : asleep || paused && !timers.contains(where: { $0.action == "park" }) ? 2 : 0.5 }
    func nextWake(_ now: Double, callHidden: Bool = false) -> (at: Double, source: String, leeway: Int)? {
        let interval = poll ?? (callHidden ? 2 : nil)
        let check = interval.map { now + $0 }, timer = timers.min { $0.at < $1.at }
        guard let at = [timer?.at, check].compactMap({ $0 }).min() else { return nil }
        if let timer = timer, timer.at <= at + 1e-9 { return (at, "legacy-timer:" + timer.action, 10) }
        return (at, "legacy-window-check", Int((poll ?? 0.5) * 200))
    }
    mutating func load(_ frame: SpriteFrame?) {
        self.frame = frame; book.set = frame?.lines; book.recent = [:]; seat = nil; shown = false; asleep = false; plan = nil; moving = nil; reseatAnchor = nil; timers = []; windowObservation = nil; lastWindowMismatch = nil
        silentReseats = 0; maxSilentReseatDifferencePt = 0; windowDecisions = []
        line = nil; book.showing = nil; turnOk = nil; covered = false; trail = nil
    }
    mutating func timer(_ at: Double, _ action: String) { timers.removeAll { $0.action == action }; timers.append((at, action)) }
    func origin(_ seat: PerchSeat) -> CGPoint {
        CGPoint(x: seat.x - Double(metrics?.anchor.x ?? 0), y: seat.edge - seat.rise)
    }
    func box(_ seat: PerchSeat) -> CGRect { CGRect(origin: origin(seat), size: metrics?.size ?? .zero) }
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
        if !keepSeat { seat = nil; moving = nil; reseatAnchor = nil; covered = false }
        timers.removeAll { !(keepSeat && ["return", "deep"].contains($0.action)) }
        if keepSeat && !timers.contains(where: { $0.action == "deep" }) { timer(now + 600, "deep") }
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
        case let kind? where reduced && kind != "pop" && kind != "return":
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
        case "return"?, "pop"?:
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
        case "paused": current = "paused"; t = b.play(name("paused"), at: t)
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
    // The ring drew a frame: seat (on an aim, a drag, a new window, or when nothing is perched), move, react, and the
    // frame's line.
    mutating func receive(_ ev: PerchEvent, now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out = advance(to: now, env: env)
        guard let m = metrics else { return out }
        let woke = asleep
        lastFrame = now; asleep = false; trail = nil
        // C1's pause: the paused pose stops after 10 minutes; any other frame resumes.
        paused = ev.state == "paused"
        timers.removeAll { ["sleep", "still", "wait-end", "drop", "long-wait", "deep"].contains($0.action) }
        if paused { timer(now + 600, "deep") }
        let moment = book.moment(ev.state, ok: ev.ok, woke: woke)
        // A turn's end (the relay's done without ok) high-fives when the turn's last call succeeded.
        let state = ev.state == "done" && !ev.ok && turnOk == true ? "turn-success" : ev.state
        if ev.state == "done" { turnOk = ev.ok ? true : nil } else if ev.state == "error" { turnOk = false } else if ev.state == "handback" { turnOk = nil }
        if moving != nil { current = ["type", "key", "scroll", "drag"].contains(ev.state) ? "perch-peek" : ev.state == "waiting" ? "perch-wait" : "perch"; return out }
        var move: String?
        if ev.state == "aim" || ev.state == "drag" || seat == nil || seat?.window != ev.window || seat?.pid != ev.pid || !shown {
            switch perchPlace(env.world(ev.pid, ev.window), pid: ev.pid, window: ev.window, target: ev.at, also: ev.end, metrics: m, previous: seat) {
            case let .hide(reason):
                // Covered: keep the seat, so the window checks bring the character back once the edge clears.
                let keep = reason == "covered" && seat?.window == ev.window && seat?.pid == ev.pid
                out += hide(now, reason, keepSeat: keep); covered = keep
                return out
            case let .seat(s):
                if !shown || seat == nil { move = "arrive" }
                else if let old = seat, old.window != s.window || old.pid != s.pid {
                    let d = hypot(Double(origin(s).x - origin(old).x), Double(origin(s).y - origin(old).y))
                    // Another display: only the new seat draws (one panel never spans two displays).
                    move = old.display != s.display ? "pop" : d <= 400 ? "leap" : "far"
                } else if let old = seat, abs(old.x - s.x) > 0.5 || abs(old.edge - s.edge) > 0.5 {
                    move = abs(old.x - s.x) > 360 ? "run" : "hop"
                }
                seat = s; reseatAnchor = s.frame; covered = false
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
    // Trail mode (the sprite beside the ring): the same lines book, with the bubble by the sprite's box.
    mutating func trail(_ ev: PerchEvent, box: CGRect, world: PerchWorld, now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out = advance(to: now, env: env)
        guard frame?.lines != nil else { return out }
        lastFrame = now; trail = (box, world.display, world.top)
        timers.removeAll { $0.action == "long-wait" }
        let moment = book.moment(ev.state, ok: ev.ok, woke: false)
        if ["thinking", "waiting"].contains(ev.state) { timer(now + 12, "long-wait") }
        if let moment = moment { out += say(moment, now: now, act: handKinds.contains(ev.state), target: ev.at, env: env) }
        return out
    }
    // Where a line goes: over the perched box, or by the trail sprite.
    var lineBox: (box: CGRect, display: CGRect, top: Double)? {
        if shown, let seat = seat { return (box(seat), seat.display, seat.top) }
        return trail
    }
    mutating func say(_ moment: String, now: Double, act: Bool, target: CGPoint?, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        guard let place = lineBox else { return [] }
        switch book.decide(moment, now: now, act: act) {
        case .drop, .hold: return []
        case .show:
            guard let (index, text) = book.pick(moment) else { return [] }
            if ["start", "typing", "first-click", "done"].contains(moment) { book.said.insert(moment) }
            if moment == "start" { book.startPending = false }
            let until = now + min(4, 1.8 + 0.04 * Double(text.count))
            let shown = PerchLine(moment: moment, text: text, index: index, until: until,
                bubble: perchBubble(text, box: place.box, display: place.display, top: place.top, avoid: target, size: env.measure(text)))
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
    // Each ring draw says whether it has a narration bubble: with one, narration holds until its span ends; without one, a
    // bubble that was up is gone, and a held line may show.
    mutating func narrationDrawn(_ span: Double?, now: Double) -> [(Double, PerchEffect)] {
        if let span = span { return narration(until: now + span, now: now) }
        if book.narrationUntil > now { book.narrationUntil = now; timer(now, "narration-end") }
        return []
    }
    // The poll: the target window gone, full screen, or moved by the person hides the character, which comes back 500 ms after
    // the frame stops changing. A window raised over the seat moves it to an uncovered span, or hides it until one clears.
    mutating func observe(_ now: Double, env: PerchEnvironment) -> [(Double, PerchEffect)] {
        var out = advance(to: now, env: env)
        guard var seat = seat, let m = metrics else { return out }
        guard let world = env.world(seat.pid, seat.window) else { return out + hide(now, "gone") }
        if world.fullScreen { return out + hide(now, "full-screen") }
        let still = moving ?? reseatAnchor ?? seat.frame
        // Both rectangles describe the target window. Drawing-panel crops and
        // layer coordinates never participate in this comparison.
        windowObservation = PerchWindowObservation(pid: seat.pid, window: seat.window, expected: still, observed: world.window)
#if SLEIGHT_STAGE_BENCH
        windowObservation?.fixture = stageBenchLegacyWindowFrame?(seat.pid, seat.window)
#endif
        if !stageSameWindowBounds(world.window, still) {
            lastWindowMismatch = windowObservation
            recordWindowDecision("moved", now: now)
            if shown { out += hide(now, "moved", keepSeat: true) }
            moving = world.window; timer(now + 0.5, "return")
            return out
        }
        if moving == nil, world.window != seat.frame {
            let delta = CGPoint(x: world.window.minX - seat.frame.minX, y: world.window.minY - seat.frame.minY)
            seat.x += delta.x; seat.edge += delta.y; seat.frame = world.window
            seat.display = world.display; seat.top = world.top; self.seat = seat
            silentReseats += 1
            maxSilentReseatDifferencePt = max(maxSilentReseatDifferencePt, stageWindowEdgeDifference(still, world.window))
            recordWindowDecision("silent-reseat", now: now)
            if var pose = plan {
                pose.seat = seat; pose.positions = pose.positions.map { ($0.0, CGPoint(x: $0.1.x + delta.x, y: $0.1.y + delta.y)) }
                plan = pose
                if shown { out.append((now, .reseat(delta))) }
            }
        }
        guard moving == nil, shown ? !perchUncovered(seat, world, m) : covered else { return out }
        // The same spot on the window; the point is below the window so nothing dodges it.
        let target = CGPoint(x: seat.x, y: Double(world.window.maxY) + 100)
        switch perchPlace(world, pid: seat.pid, window: seat.window, target: target, metrics: m, previous: nil) {
        case .hide: if shown { out += hide(now, "covered", keepSeat: true) }; covered = true
        case let .seat(s):
            let move = !shown ? "return" : abs(s.x - seat.x) > 360 ? "run" : "hop"
            let from = shown ? plan?.position(at: now - began) : nil
            self.seat = s; reseatAnchor = s.frame; covered = false
            if !paused { timers.removeAll { $0.action == "deep" } }
            if let p = draw(current, ok: false, at: nil, move: move, from: from, woke: false, now: now, env: env) {
                plan = p; began = now; shown = true; out.append((now, .draw(p))); timer(now + p.duration, "park")
                if !paused { timer(now + 20, "sleep") }
            }
        }
        return out
    }
    private mutating func recordWindowDecision(_ decision: String, now: Double) {
        guard let observation = windowObservation else { return }
        windowDecisions.append(observation.json.merging(["decision": decision, "time": now]) { $1 })
        if windowDecisions.count > 128 { windowDecisions.removeFirst(windowDecisions.count - 128) }
    }
    // A microphone completion observes geometry and due timers, but never restarts an unchanged installed pose.
    mutating func observeCall(now: Double, env: PerchEnvironment, visible: Bool) -> [(Double, PerchEffect)] {
        let previous = plan, previousBegan = began, wasShown = shown
        let effects = observe(now, env: env)
        return preserveInstalledPose(effects, previous: previous, previousBegan: previousBegan, wasShown: wasShown, visible: visible)
    }
    // Only a paused replay may retain its installed pose. Actions must replay their reaction.
    mutating func receiveVisible(_ ev: PerchEvent, now: Double, env: PerchEnvironment, visible: Bool) -> [(Double, PerchEffect)] {
        let previous = plan, previousBegan = began, wasShown = shown
        let effects = receive(ev, now: now, env: env)
        guard ev.state == "paused" else { return effects }
        return preserveInstalledPose(effects, previous: previous, previousBegan: previousBegan, wasShown: wasShown, visible: visible)
    }
    private mutating func preserveInstalledPose(_ incoming: [(Double, PerchEffect)], previous: PerchPlan?, previousBegan: Double,
        wasShown: Bool, visible: Bool) -> [(Double, PerchEffect)] {
        var effects = incoming
        if wasShown && visible && shown, !effects.contains(where: { if case .hide = $0.1 { return true }; return false }),
            let previous = previous, let current = plan, previous.samePose(as: current) {
            effects.removeAll { if case .draw = $0.1 { return true }; return false }
            plan = previous; began = previousBegan
        }
        return effects
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
                // A held line shows when narration ends, unless it is over 5 s old.
                if let held = book.held { book.held = nil; if at - held.at <= 5 { out += say(held.moment, now: at, act: held.act, target: nil, env: env) } }
            case "long-wait": out += say("long-wait", now: at, act: false, target: nil, env: env)
            case "sleep":
                guard shown, !paused, seat != nil else { continue }
                if let p = draw("sleep", ok: false, at: nil, move: nil, from: nil, woke: false, now: at, env: env) {
                    plan = p; began = at; asleep = true; book.turnOpen = false
                    out.append((at, .draw(p)))
                    timer(at + p.duration, "park")
                    if !p.reduced { timer(at + max(p.duration, 6.6), "still") }
                    timer(at + 600, "deep")
                }
            case "deep":
                // 10 quiet minutes asleep, covered or paused: hide and stop checks until the next frame or unpause.
                if asleep || covered || paused { out += hide(at, paused ? "paused" : covered ? "covered" : "asleep") }
            case "wait-end", "drop":
                guard shown, let p = draw("perch", ok: false, at: nil, move: nil, from: nil, woke: false, now: at, env: env) else { continue }
                plan = p; began = at; out.append((at, .draw(p))); timer(at + p.duration, "park")
                if !paused { timer(at + 20, "sleep") }
            case "return":
                guard let seat = seat, let m = metrics else { continue }
                guard let world = env.world(seat.pid, seat.window) else { out += hide(at, "gone"); continue }
                if moving.map({ stageSameWindowBounds(world.window, $0) }) != true { moving = world.window; timer(at + 0.5, "return"); continue }
                moving = nil
                // The same spot on the moved window; the point is below the window so nothing dodges it.
                let target = CGPoint(x: seat.x + Double(world.window.minX - seat.frame.minX), y: Double(world.window.maxY) + 100)
                switch perchPlace(world, pid: seat.pid, window: seat.window, target: target, metrics: m, previous: nil) {
                case let .hide(reason):
                    if reason == "covered" {
                        self.seat?.x = Double(target.x); self.seat?.edge = Double(world.window.minY)
                        self.seat?.frame = world.window; self.seat?.display = world.display; self.seat?.top = world.top
                        reseatAnchor = world.window
                        covered = true
                    } else { out += hide(at, reason) }
                case let .seat(s):
                    self.seat = s; reseatAnchor = s.frame; covered = false
                    if !paused { timers.removeAll { $0.action == "deep" } }
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
// BEGIN STAGE PANEL LIFETIME
// The panel owner is shared by the drawing host and the headless dump. Only window
// visibility and lifetime are observed; the dump cannot supply a measurement.
protocol StagePanelWindow: AnyObject {
    var isVisible: Bool { get }
    func orderOut(_ sender: Any?)
    func close()
}
final class StagePanelLifetime<Window: StagePanelWindow> {
    var panel: Window?
    var panelOnScreen: Bool { panel?.isVisible == true }
    func release() {
        panel?.orderOut(nil); panel?.close(); panel = nil
    }
    func hide(_ reason: String, duration: Double, release: () -> Void, fade: (Double) -> Void) {
        if reason != "hide" || duration == 0 { release(); return }
        fade(duration)
    }
}
// END STAGE PANEL LIFETIME
extension HandPanel: StagePanelWindow {}

#if SLEIGHT_STAGE_BENCH
struct StageBenchPlanSequence {
    private var value = 0
    private var values: [UUID: Int] = [:]
    // Negative identities cannot collide with the stage path's nonnegative producer sequences.
    mutating func next(_ plan: PerchPlan) -> Int {
        if let value = values[plan.stageBenchIdentity] { return value }
        value -= 1; values[plan.stageBenchIdentity] = value; return value
    }
}
#endif
final class PerchHost {
    weak var host: HandHost?
#if SLEIGHT_STAGE_BENCH
    var stageBenchLegacyPlans = StageBenchPlanSequence()
    var stageBenchInstallCause = "unattributed"
    // Caller and runtime transition are both retained, since a timer or seat hop may run inside an observation.
    func stageBenchCause(_ path: String, previousSeat: PerchSeat?, due: [String]) -> String {
        var parts = [path]
        if !due.isEmpty { parts.append("due-timer:" + due.joined(separator: ",")) }
        if let seat = runtime.seat, seat != previousSeat { parts.append(previousSeat == nil ? "startup" : "seat-hop") }
        return parts.joined(separator: "/")
    }
#endif
    var runtime = PerchRuntime()
    var stage = StageRuntime(), stageLocked = false, stageSleeping = false
    let stageSlot: StageSlot
#if SLEIGHT_CALL_SELFTEST
    // Compiled only by the offline wiring tests. The production methods still own every transition.
    var callTestClock: Double?
    var callTestWorld: StageWorld?, callTestInstalls = 0, callTestVisible = false, callTestReduced = true
#endif
    var stageObservers: [(NotificationCenter, NSObjectProtocol)] = []
    var stageMouseMonitors: [Any] = []
    var pointerWake: DispatchWorkItem?, pointerCheckAt = -Double.infinity
    var pointerNearAt = CACurrentMediaTime()
    var stageWindow: (pid: Int32, window: UInt32)?
    let stageCall = StageCallMonitor()
    var legacyCallEvent: PerchEvent?, legacyCallAt = -Double.infinity
    var lastHideReason: String? = nil
    // Observational only. Reading status neither samples Core Audio nor changes rendering.
    var diagnostics: [String: Any] {
        let stagePath = stageActive
        let up = (stagePath ? stage.shown : runtime.shown) && panel?.isVisible == true
        // Describe existing protection state only. Do not poll windows or admit a target to answer status.
        let wide: [[String: Any]] = stage.wideWindows.sorted {
            $0.pid == $1.pid ? $0.window < $1.window : $0.pid < $1.pid
        }.map { key in
            var reasons: [String] = []
            if stage.compactedWindows.contains(key) { reasons.append("capacity") }
            if stage.unmappableDrags.contains(key) { reasons.append("drag") }
            // The runtime retains an uncertainty latch, not a historical trigger log. Do not invent a precise cause.
            if reasons.isEmpty { reasons.append("uncertain-geometry-scroll-epoch-or-stale") }
            let bounds = stage.windowBook.current[key]?.bounds ?? stage.wideObservedFrames[key]
            return ["pid": key.pid, "id": key.window, "frame": bounds.map(stageTraceRect) as Any? ?? NSNull(),
                "reasons": reasons]
        }
        return stageVisibilityStatus(stagePath: stagePath, stageShown: stage.shown, legacyShown: runtime.shown,
            panelVisible: panel?.isVisible == true, rung: stage.draw?.seat.rung,
            reason: stagePath ? stage.hiddenReason ?? lastHideReason : lastHideReason)
            .merging(["callMonitor": stageCall.snapshot(now),
                "turnTargets": stagePath ? stage.turnTargets.count : 0,
                "activeTargets": stagePath ? stage.activeTargets.count : 0, "wideWindows": wide,
                "areaProtection": stagePath && stage.event?.area != nil && !stage.wideWindows.isEmpty,
                "usableFrame": (stage.seat?.world.usable ?? stage.noSeatWorld?.usable).map(stageTraceRect) as Any? ?? NSNull(),
                "protectedRects": stagePath ? (stage.exclusions + stage.activeTargets).map(stageTraceRect) : [],
                "panelGenerations": panelGenerations, "hideReasonCounts": stage.hideReasonCounts, "maxWindowBoundsDifferencePt": stage.maxWindowBoundsDifferencePt as Any? ?? NSNull(),
                "legacyWindowObservation": runtime.windowObservation?.json as Any? ?? NSNull(),
                "legacyWindowMismatch": runtime.lastWindowMismatch?.json as Any? ?? NSNull(),
                "legacySilentReseats": runtime.silentReseats, "legacyMaxSilentReseatDifferencePt": runtime.maxSilentReseatDifferencePt,
                "legacyWindowDecisions": runtime.windowDecisions,
                "stageSilentReseats": stage.silentReseats, "stageMaxSilentReseatDifferencePt": stage.maxSilentReseatDifferencePt,
                "stageWindowDecisions": stage.windowDecisions,
                "drawing": drawingGeometry?.json as Any? ?? NSNull(),
                "seat": up ? (stagePath ? stage.draw?.seat.kind ?? "unknown" : "legacy-perch") as Any : NSNull()]) { $1 }
    }
    var stageActive: Bool { active && loaded?.frame.stageOptions.enabled == true }
    var enabled = false, lines = true
    var loaded: SpriteCharacter?
    var stageEffects: (([StageEffect]) -> Void)?
    var panelGenerations = 0
    let panelLifetime = StagePanelLifetime<HandPanel>()
    var panel: HandPanel? { get { panelLifetime.panel } set { panelLifetime.panel = newValue } }
    var root: CALayer?, boxLayer: CALayer?, maskLayer: CALayer?, zs: CAReplicatorLayer?, frame = CGRect.null
    var drawingGeometry: SpritePanelGeometry?
    var bubble: PerchBubblePanel?
    var wake: DispatchSourceTimer?
    init(host: HandHost, stageSlot: StageSlot = StageSlot()) {
        self.stageSlot = stageSlot
        self.host = host; runtime.seed = UInt64.random(in: 1...UInt64.max); runtime.book.seed = runtime.seed
        stageCall.changed = { [weak self] in
            guard let self = self, self.host?.cursorStyle == "sprite", self.loaded != nil, !self.stageLocked, !self.stageSleeping else { return }
            if !self.active {
                if self.legacyCallBlocked() { self.host?.hideRingCharacter(); self.hideLegacyCall() }; return
            }
            if self.stageActive, self.stage.event != nil {
                self.performStage(self.stage.observe(self.now, world: self.stageEnvironment(), reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
            } else if !self.stageActive { self.observeLegacyCall() }
        }
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") { return }
#endif
        func observe(_ center: NotificationCenter, _ name: Notification.Name, _ change: @escaping (PerchHost) -> Void) {
            let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self = self else { return }; change(self)
                if self.stageLocked || self.stageSleeping { self.host?.edgeChips.hide() }
                else { self.host?.edgeChips.refresh() }
                if self.stageActive { self.performStage(self.stage.observe(self.now, world: self.stageEnvironment(), reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)) }
            }
            stageObservers.append((center, token))
        }
        let workspace = NSWorkspace.shared.notificationCenter, distributed = DistributedNotificationCenter.default()
        observe(workspace, NSWorkspace.willSleepNotification) { $0.stageCall.refreshSubscription() }
        observe(workspace, NSWorkspace.didWakeNotification) { $0.stageCall.refreshSubscription() }
        observe(workspace, NSWorkspace.screensDidSleepNotification) { $0.stageSleeping = true; $0.stageCall.refreshSubscription() }
        observe(workspace, NSWorkspace.screensDidWakeNotification) { $0.stageSleeping = false; $0.stageCall.refreshSubscription() }
        observe(workspace, NSWorkspace.sessionDidResignActiveNotification) { $0.stageLocked = true }
        observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { $0.stageLocked = false }
        observe(distributed, Notification.Name("com.apple.screenIsLocked")) { $0.stageLocked = true }
        observe(distributed, Notification.Name("com.apple.screenIsUnlocked")) { $0.stageLocked = false }
        observe(workspace, NSWorkspace.activeSpaceDidChangeNotification) { _ in }
        observe(workspace, NSWorkspace.didActivateApplicationNotification) { _ in }
        observe(.default, NSApplication.didChangeScreenParametersNotification) { _ in }
    }
    func configureStageMouse() {
        guard stageActive else {
            for token in stageMouseMonitors { NSEvent.removeMonitor(token) }; stageMouseMonitors = []
            pointerWake?.cancel(); pointerWake = nil; return
        }
        guard stageMouseMonitors.isEmpty else { return }
        let mouse: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        if let token = NSEvent.addGlobalMonitorForEvents(matching: mouse, handler: { [weak self] event in self?.stagePointerChanged(event.timestamp) }) { stageMouseMonitors.append(token) }
        if let token = NSEvent.addLocalMonitorForEvents(matching: mouse, handler: { [weak self] event in self?.stagePointerChanged(event.timestamp); return event }) { stageMouseMonitors.append(token) }
    }

    deinit {
        for (center, token) in stageObservers { center.removeObserver(token) }
        for token in stageMouseMonitors { NSEvent.removeMonitor(token) }
        pointerWake?.cancel()
    }
    func stagePointerChanged(_ enteredAt: Double) {
        guard stageActive, stage.pointerActive, !stageLocked, !stageSleeping, pointerWake == nil else { return }
        // Coalesce high-rate mouse streams to at most one metadata read per 150 ms. The first event after idle is immediate.
        let delay = max(0, 0.15 - (now - pointerCheckAt))
        let deliver = { [weak self] in
            guard let self = self else { return }; self.pointerWake = nil
            guard self.stageActive, self.stage.pointerActive, !self.stageLocked, !self.stageSleeping else { return }
            self.pointerCheckAt = self.now
            let world = self.stageEnvironment()
#if SLEIGHT_STAGE_BENCH
            let pointerPanelID = self.panel?.windowNumber, pointerBox = self.stage.draw?.seat.box
#endif
            let effects = self.stage.pointerChanged(self.now, enteredAt: enteredAt, world: world, reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
            self.performStage(effects)
#if SLEIGHT_STAGE_BENCH
            stageBenchPointerObserved?(effects, pointerPanelID, pointerBox, enteredAt)
#endif
        }
        if delay == 0 { deliver() }
        else { let work = DispatchWorkItem(block: deliver); pointerWake = work; DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work) }
    }
    func stageEnvironment() -> StageWorld? {
        // A window-list sample is a veto, never a presentation lock. In
        // particular, equal bounds cannot detect an intervening change/restore.
        guard var ev = stage.event else { yieldStageSlot(); return nil }
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") {
            guard var world = callTestWorld else { yieldStageSlot(); return nil }
            world.call = stageCall.active(now)
            world.stageAvailable = stageAdmission(world)
            return world
        }
#endif
        if let world = host?.admissionWorld { return world(ev) }
        let at = now
        stage.locked = stageLocked; stage.displaySleeping = stageSleeping
        guard !stage.locked, !stage.displaySleeping else { pointerWake?.cancel(); pointerWake = nil; yieldStageSlot(); return nil }
        if stageWindow?.pid != ev.pid || stageWindow?.window != ev.window {
            stageWindow = (ev.pid, ev.window); pointerNearAt = at
        }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let locked = stageLocked || (session?["CGSSessionScreenIsLocked"] as? Bool == true)
        stage.locked = locked
        guard !locked else { yieldStageSlot(); return nil }
        guard let snapshot = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { yieldStageSlot(); return nil }
        let namedPids = stageWidePids(stage.wideNames, snapshot: snapshot, bundle: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier })
        if stage.wideApps.union(namedPids).count > 128 { stage.targetCapacity = true }
        else { stage.wideApps.formUnion(namedPids) }
        let areaApps = stage.wideApps.union(stage.wideWindows.map { $0.pid }).union(ev.area != nil ? [ev.pid] : [])
        let observedWindows = stageWindows(snapshot, areaApps: areaApps)
        stage.observeWindows(observedWindows)
        if stage.windowBook.current[StageWindowKey(pid: ev.pid, window: ev.window)] == nil,
            let key = observedWindows.keys.filter({ $0.pid == ev.pid || ev.pid == 0 && stage.wideApps.contains($0.pid) }).sorted(by: { $0.pid == $1.pid ? $0.window < $1.window : $0.pid < $1.pid }).first,
            let bounds = stage.windowBook.current[key]?.bounds {
            let reason = ev.wideReason
            ev = PerchEvent(state: ev.state, pid: key.pid, window: key.window, at: CGPoint(x: bounds.midX, y: bounds.midY),
                ok: ev.ok, drop: nil, end: nil, area: "app", wideReason: reason)
            stage.wideApps.insert(key.pid)
            for candidate in observedWindows.keys where candidate.pid == ev.pid { stage.invalidateGeometry(candidate) }
            stage.event = ev
        }
        guard var world = stageWorld(pid: ev.pid, window: ev.window, pointerAway: max(0, at - pointerNearAt),
            locked: locked, sleeping: stageSleeping, call: stageCall.active(at), snapshot: snapshot) else { yieldStageSlot(); return nil }
        if !areaApps.isEmpty { world.windows = stageWindows(snapshot, areaApps: areaApps) }
        // The badge is an intentional input target. Approaching that 16 pt corner must not dodge it away.
        stage.badgeApproach = host?.pauseOverlay.panel.map { $0.isVisible && $0.frame.insetBy(dx: -40, dy: -40).contains(NSEvent.mouseLocation) } ?? false
        if stageDistance(world.pointer, world.base.window) <= 100 { pointerNearAt = at; world.pointerAway = 0 }
        world.stageAvailable = stageAdmission(world)
        return world
    }
    // Ordering out precedes unlocking, including a display transfer and attention shrinking to medium.
    func yieldStageSlot() {
        if stageSlot.display != nil { release(); _ = stage.hide("stage-slot", immediate: true, at: now) }
        stageSlot.release()
    }
    func stageAdmission(_ world: StageWorld) -> Bool {
        guard stage.options.size == "stage", !world.stopped, !world.call,
            loaded?.frame.stage?.values.contains(where: { $0.file != nil }) == true,
            !(stage.options.attention && world.inputAge < 8 && world.person != world.base.window),
            let display = world.displayID else { yieldStageSlot(); return false }
        if stageSlot.display != display { yieldStageSlot() }
        let held = stageSlot.display != nil
        let admitted = stageSlot.claim(display)
        if !admitted && held { yieldStageSlot() }
        return admitted
    }
    func releaseUnusedStageSlot(visible: Bool) {
        // A fading stage still owns its slot until the panel orders out. A parked medium never owns one.
        if !visible || stage.shown && !["stage", "three-quarter"].contains(stage.seat?.rung ?? "") { stageSlot.release() }
    }
    func performStage(_ effects: [StageEffect]) {
        var effects = stageCallApply(effects, runtime: &stage, active: { stageCall.active(now) }, at: now)
        // Recheck at main-queue application as well as planning. No native
        // scope proves an ambient motion envelope, so even an older queued
        // draw must stay hidden for the producer's entire protected turn.
        if stage.producerOwner != nil || stage.producerCollectionOnly {
            if effects.contains(where: { switch $0 { case .draw, .reseat: return true; default: return false } }) {
                effects = stage.hide("producer-presentation-unproved", immediate: true, at: now)
            }
        }
        if let deliver = stageEffects { deliver(effects); return }
        guard host?.badgeDrag.active != true else { return }
        for effect in effects {
            switch effect {
            case let .draw(draw):
                guard host?.captureHeld != true else { takeDown(); return }
#if SLEIGHT_STAGE_BENCH
                stageBenchPlanned?(draw.seq, draw.pose, draw.metrics)
                let previousInstallCause = stageBenchInstallCause
                stageBenchInstallCause = "stage-draw/" + (draw.pose.cells.last?.state ?? "unknown") +
                    (draw.decisionReason.map { "/" + $0 } ?? "")
                defer { stageBenchInstallCause = previousInstallCause }
#endif
                lastHideReason = nil
                closeBubble(); install(draw.pose, stageMetrics: draw.metrics, stagePose: draw.art)
                if let panel = panel {
                    let actual = HandPanelPolicy(panel)
                    stage.draw?.panelPolicy = actual
                    if !actual.stageSafe(for: host?.capture ?? "hidden") { spriteWarning("stage panel policy mismatch: capture=\(actual.captureName) hitAreas=\(actual.hitAreas)"); takeDown(); return }
                }
            case let .hide(reason, duration):
                lastHideReason = reason
                panelLifetime.hide(reason, duration: duration, release: release) { duration in
                    func stop(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(stop) }
                    root.map(stop); fadeOut(duration)
                }
            case let .reseat(delta):
                guard host?.captureHeld != true else { takeDown(); return }
                if !reseat(delta, checked: true) { performStage(stage.hide("panel-moved", immediate: true, at: now)); return }
            case .park:
                func stop(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(stop) }
                root.map(stop)
            }
        }
        var visible = panel?.isVisible == true
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") { visible = callTestVisible }
#endif
        releaseUnusedStageSlot(visible: visible); schedule()
    }
    // Perch mode: perch on and a character frame with a perch table (the relay sends one only with perch on).
    var active: Bool { enabled && host?.cursorStyle == "sprite" && loaded?.frame.perch != nil }
    // Lines: in either sprite mode, while lines are on and the pack has some.
    var talking: Bool { lines && host?.cursorStyle == "sprite" && loaded?.frame.lines != nil }
    // A character load, a style change or the options frame: which runtime gets the character (ring trail or perch).
    func configure(character: SpriteCharacter? = nil, replace: Bool = false, perch: Bool? = nil, lines: Bool? = nil) {
        let was = active, seq = loaded?.frame.seq, sprite = host?.cursorStyle == "sprite"
        if replace { loaded = character }
        if let perch = perch { enabled = perch }
        if let lines = lines { self.lines = lines; runtime.book.enabled = lines; if !lines { perform(runtime.dismiss(now)) } }
        if active != was || loaded?.frame.seq != seq || replace && loaded == nil {
            takeDown(); runtime.load(sprite ? loaded?.frame : nil); stage.load(sprite ? loaded?.frame : nil)
            if let character = loaded {
                stage.artProvider = { state in character.stage.select(state, images: character.images) }
            } else { stage.artProvider = nil }
            runtime.book.enabled = self.lines
            runtime.legs = active ? loaded.flatMap { perchLegs($0) } : nil
        }
        configureStageMouse()
        if sprite { host?.ringRuntime.character = active ? nil : loaded }
    }
    var now: Double {
#if SLEIGHT_CALL_SELFTEST
        if let clock = callTestClock { return clock }
#endif
        return CACurrentMediaTime()
    }
    var environment: PerchEnvironment {
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") {
            return PerchEnvironment(world: { [weak self] _, _ in self?.callTestWorld?.base },
                reduced: { [weak self] in self?.callTestReduced ?? true }, measure: { _ in .zero })
        }
#endif
        return PerchEnvironment(world: { pid, window in perchWorld(pid: pid, window: window) },
            reduced: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }, measure: perchMeasure)
    }
    // The legacy renderer keeps its last event while call-hidden so a quiet completion can re-admit it.
    func legacyCallBlocked() -> Bool {
        return stageCall.active(now)
    }
    func hideLegacyCall() {
        if lastHideReason != "call" { stage.hideReasonCounts["call", default: 0] += 1 }
        _ = runtime.hide(now, "call")
        lastHideReason = "call"; release(); closeBubble(); schedule()
    }
    var legacyPanelVisible: Bool {
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") { return callTestVisible }
#endif
        return panel?.isVisible == true
    }
    func observeLegacyCall() {
        guard active, !stageActive, let event = legacyCallEvent else { return }
        if now - legacyCallAt >= 600 {
            legacyCallEvent = nil; _ = runtime.hide(now, "asleep")
            lastHideReason = "asleep"; release(); closeBubble(); schedule(); return
        }
        if legacyCallBlocked() { hideLegacyCall(); return }
#if SLEIGHT_STAGE_BENCH
        let stageBenchPreviousCause = stageBenchInstallCause, stageBenchPreviousSeat = runtime.seat
        let stageBenchDue = runtime.timers.filter { $0.at <= now }.map { $0.action }.sorted()
        defer { stageBenchInstallCause = stageBenchPreviousCause }
#endif
        if !runtime.shown && lastHideReason == "call" {
            let effects = runtime.receive(event, now: now, env: environment)
#if SLEIGHT_STAGE_BENCH
            stageBenchInstallCause = stageBenchCause("call-restore", previousSeat: stageBenchPreviousSeat, due: stageBenchDue)
#endif
            perform(effects)
        } else {
            var visible = panel?.isVisible == true
#if SLEIGHT_CALL_SELFTEST
            if CommandLine.arguments.contains("--call-host-selftest") { visible = callTestVisible }
#endif
            let effects = runtime.observeCall(now: now, env: environment, visible: visible)
#if SLEIGHT_STAGE_BENCH
            stageBenchInstallCause = stageBenchCause(stageBenchPreviousCause == "wake" ? "wake" : "call-observe",
                previousSeat: stageBenchPreviousSeat, due: stageBenchDue)
#endif
            perform(effects)
        }
    }
    func dissolve(_ event: RingEvent) -> CGPoint? { active && !stageActive ? runtime.dissolve(event) : nil }
    // Each ring draw: C1's clear state, C2's narration bubble (narration first), then the perch or the trail sprite's line.
    func ringDrew(_ plan: RingPlan) {
        guard active || talking, let frame = loaded?.frame else { return }
        let at = now
#if SLEIGHT_STAGE_BENCH
        let stageBenchPreviousCause = stageBenchInstallCause, stageBenchPreviousSeat = runtime.seat
        let stageBenchDue = runtime.timers.filter { $0.at <= at }.map { $0.action }.sorted()
        stageBenchInstallCause = "ring-receive"
        defer { stageBenchInstallCause = stageBenchPreviousCause }
#endif
        if stageActive {
            stage.carrying = host?.honestMood.carrying == true
            stage.carryUntil = host?.honestMood.carryUntil ?? 0
            stage.held = host?.captureHeld == true
            stage.paused = host?.pauseControl.paused == true
            let event = perchEvent(plan)
            let previous = stage.event
            stage.event = event
            let world = stageEnvironment()
            stage.event = previous
            performStage(stage.receive(event, seq: plan.seq, rect: plan.rect, now: at, world: world, reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, producer: plan.producer, protectsTarget: plan.protectsTarget))
            return
        }
        if active {
            legacyCallEvent = perchEvent(plan); legacyCallAt = at
            if legacyCallBlocked() { hideLegacyCall(); return }
        } else if talking && legacyCallBlocked() { hideLegacyCall(); return }
        runtime.book.cleared = host?.pauseVisibility.cleared ?? false
        var effects = runtime.narrationDrawn(plan.bubble == nil ? nil : perchNarrationSpan(plan), now: at)
        if active { effects += runtime.receiveVisible(perchEvent(plan), now: at, env: environment, visible: legacyPanelVisible) }
        else if let world = perchWorld(pid: plan.pid, window: plan.window), let box = perchTrailBox(plan.at, frame: frame, clip: world.window) {
            effects += runtime.trail(perchEvent(plan), box: box, world: world, now: at, env: environment)
        }
#if SLEIGHT_STAGE_BENCH
        stageBenchInstallCause = stageBenchCause("ring-receive", previousSeat: stageBenchPreviousSeat, due: stageBenchDue)
#endif
        perform(effects)
    }
    func takeDown() {
        wake?.cancel(); wake = nil
        legacyCallEvent = nil
        lastHideReason = "hide"
        _ = runtime.hide(now, "hide"); _ = stage.hide("hide", immediate: true, at: now); stage.event = nil
        release(); closeBubble()
    }
    func perform(_ effects: [(Double, PerchEffect)]) {
        guard host?.badgeDrag.active != true else { return }
        if (active || talking) && !stageActive && legacyCallBlocked() { hideLegacyCall(); return }
        for (_, effect) in effects {
            switch effect {
            case let .draw(plan): if host?.captureHeld == true { takeDown(); return }; lastHideReason = nil; install(plan)
            case let .reseat(delta):
                guard host?.captureHeld != true else { takeDown(); return }
                reseat(delta)
            case let .hide(reason, duration):
                if !stageActive && lastHideReason != reason { stage.hideReasonCounts[reason, default: 0] += 1 }
                lastHideReason = reason; fadeOut(duration)
            case .park:
                // The Zs finish on their own clock (the still effect); everything else stops here.
                func strip(_ layer: CALayer) { guard layer !== zs else { return }; layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                root.map(strip)
            case .still:
                func strip(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                root.map(strip); zs?.instanceCount = 1
            case let .line(line): if host?.pauseVisibility.cleared != true { showBubble(line) }
            case let .lineOut(duration): closeBubble(fade: duration)
            }
        }
        schedule()
    }
    // One one-shot wake for the earliest timer or the next window check, with leeway so the system can coalesce it: 10 ms
    // for a timer that changes the drawing, a fifth of the interval for a check. Nothing is scheduled with nothing perched.
    func schedule() {
        wake?.cancel(); wake = nil
        if stageActive {
            guard let due = stage.nextWake(now)?.at else { return }
            let source = DispatchSource.makeTimerSource(queue: .main)
            source.schedule(deadline: .now() + max(0.001, due - now), leeway: .milliseconds(5))
            source.setEventHandler { [weak self] in
                guard let self = self else { return }
                self.performStage(self.stage.observe(self.now, world: self.stageEnvironment(), reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
            }
            wake = source; source.resume(); return
        }
        guard let due = runtime.nextWake(now, callHidden: active && legacyCallEvent != nil && lastHideReason == "call") else { return }
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + max(0, due.at - now), leeway: .milliseconds(due.leeway))
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.wake?.cancel(); self.wake = nil
#if SLEIGHT_STAGE_BENCH
            let stageBenchPreviousCause = self.stageBenchInstallCause, stageBenchPreviousSeat = self.runtime.seat
            let stageBenchDue = self.runtime.timers.filter { $0.at <= self.now }.map { $0.action }.sorted()
            self.stageBenchInstallCause = "wake"
            defer { self.stageBenchInstallCause = stageBenchPreviousCause }
#endif
            if self.active && self.legacyCallEvent != nil { self.observeLegacyCall() }
            else {
                let effects = self.runtime.observeCall(now: self.now, env: self.environment, visible: self.legacyPanelVisible)
#if SLEIGHT_STAGE_BENCH
                self.stageBenchInstallCause = self.stageBenchCause("wake", previousSeat: stageBenchPreviousSeat, due: stageBenchDue)
#endif
                self.perform(effects)
            }
        }
        wake = source
        source.resume()
    }
    // A small window correction translates the existing backing and animation clock together.
    @discardableResult func reseat(_ delta: CGPoint, checked: Bool = false) -> Bool {
        guard let panel = panel, !frame.isNull else { return false }
        frame = frame.offsetBy(dx: delta.x, dy: delta.y)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        panel.setFrame(appKitRect(frame), display: false)
        let accepted = !checked || stagePanelFrameAccepted(target: appKitRect(frame), actual: panel.frame)
        if let bubble = bubble { bubble.setFrame(bubble.frame.offsetBy(dx: delta.x, dy: -delta.y), display: false) }
        host?.pauseOverlay.translate(delta, owner: panel)
        CATransaction.commit()
        if let geometry = drawingGeometry {
            drawingGeometry = geometry.offsetBy(delta)
        }
        return accepted
    }
    func install(_ plan: PerchPlan, stageMetrics: PerchMetrics? = nil, stagePose: SpriteStagePose? = nil) {
#if SLEIGHT_STAGE_BENCH
        let stageBenchBegan = CACurrentMediaTime()
#endif
        guard let character = loaded, let metrics = stageMetrics ?? runtime.metrics, !plan.cells.isEmpty else { return }
#if SLEIGHT_STAGE_BENCH
        if stageMetrics == nil { stageBenchPlanned?(stageBenchLegacyPlans.next(plan), plan, metrics) }
#endif
#if SLEIGHT_CALL_SELFTEST
        if CommandLine.arguments.contains("--call-host-selftest") {
            callTestInstalls += 1; callTestVisible = true
#if SLEIGHT_STAGE_BENCH
            stageBenchInstalled?(self, plan, metrics, stagePose, (CACurrentMediaTime() - stageBenchBegan) * 1000)
#endif
            return
        }
#endif
        let cell = stagePose?.cell ?? character.frame.cell
        var box = CGRect.null
        for (_, p) in plan.positions { box = box.union(CGRect(origin: p, size: metrics.size)) }
        let logicalPanel = stageMetrics == nil ? box.insetBy(dx: -24, dy: -44) : stagePanelBounds(plan, metrics)
        // Only the physical panel changes. Layer coordinates, cell transforms, the
        // seat, pause badge and every clearance/motion check keep the logical box.
        let hasExtras = plan.zs || character.frame.sessionBadge != nil || host?.honestMood.detail != nil ||
            host?.honestMood.retry == true || host?.honestMood.carrying == true
        // Legacy panels requested fractional frames. Preserve their existing
        // AppKit rounding phase when replacing that frame with an integral crop.
        let panelOffset = stageMetrics == nil ? spritePanelRoundingOffset(appKitRect(logicalPanel)) : .zero
        let drawingOffset = hasExtras ? .zero : panelOffset
        let drawingClip = stageMetrics == nil ? CGRect(x: logicalPanel.minX + panelOffset.x, y: logicalPanel.minY + panelOffset.y,
            width: ceil(logicalPanel.width), height: ceil(logicalPanel.height)) : logicalPanel
        let geometry = spritePanelGeometry(plan, metrics: metrics, cell: cell, logicalPanel: logicalPanel,
            offset: panelOffset, clip: drawingClip, hasExtras: hasExtras) { sheet in
                stagePose?.ink ?? character.ink[sheet] ?? CGRect(origin: .zero, size: cell)
            }
        let target = geometry.target
        drawingGeometry = geometry
        if self.panel == nil { panelGenerations += 1 }
        let panel = self.panel ?? makeHandPanel(capture: host?.capture ?? "hidden")
        self.panel = panel; frame = target
        if stageMetrics != nil { _ = stagePanelSnapshot(panel, capture: host?.capture ?? "hidden") }
        else { HandPanelPolicy(sharing: handCaptureModes[host?.capture ?? "hidden"] ?? NSWindow.SharingType.none).apply(panel) }
        // AppKit submits frame changes outside the layer transaction. Hide the
        // window first so committed old art cannot appear at its new location.
        if panel.isVisible && panel.frame != appKitRect(target) { panel.orderOut(nil) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        root?.removeFromSuperlayer() // Exclude old art before AppKit can submit a frame change.
        if panel.frame != appKitRect(target) { panel.setFrame(appKitRect(target), display: false) }
        if stageMetrics != nil && !stagePanelFrameAccepted(target: appKitRect(target), actual: panel.frame) {
            CATransaction.commit()
            performStage(stage.hide("panel-moved", immediate: true, at: now))
            return
        }
        let root = CALayer(); root.frame = CGRect(origin: .zero, size: target.size); root.isGeometryFlipped = true
        root.masksToBounds = stageMetrics != nil
        panel.contentView?.layer?.addSublayer(root); self.root = root
        let layer = CALayer(); layer.name = "perch"; layer.anchorPoint = .zero; layer.bounds = CGRect(origin: .zero, size: cell)
        layer.contentsGravity = .resize; layer.minificationFilter = stagePose?.filter == "nearest" ? .nearest : .linear; layer.magnificationFilter = stagePose?.filter == "linear" ? .linear : .nearest
        root.addSublayer(layer); boxLayer = layer
        host?.honestMood.install(in: root, box: box.offsetBy(dx: -target.minX, dy: -target.minY), reduced: plan.reduced)
        let mask = CALayer(); mask.backgroundColor = CGColor(gray: 0, alpha: 1); mask.anchorPoint = .zero
        let cut = CGRect(x: 0, y: 0, width: Double(cell.width), height: plan.seat.rise / metrics.scale), whole = CGRect(origin: .zero, size: cell)
        mask.bounds = plan.mask(at: plan.duration) ? cut : whole; layer.mask = mask; maskLayer = mask
        let begin = CACurrentMediaTime(), length = max(plan.duration, 0.001)
        func unit(_ t: Double) -> NSNumber { NSNumber(value: min(max(t / length, 0), 1)) }
        func local(_ p: CGPoint, _ e: SpriteEntry) -> NSValue {
            NSValue(point: CGPoint(x: p.x + drawingOffset.x - target.minX + (e.flip ? metrics.size.width : 0), y: p.y + drawingOffset.y - target.minY))
        }
        // Only the key paths whose values change (PerchPlan.keyPaths, which the dump reports) get an animation; every other
        // value is set on the model.
        let animated = Set(plan.keyPaths(cell))
        func add(_ to: CALayer, _ key: String, _ values: [Any], _ times: [Double], discrete: Bool, path: String? = nil) {
            to.setValue(values.last, forKeyPath: key)
            guard values.count > 1, animated.contains(path ?? key) else { return }
            let a = CAKeyframeAnimation(keyPath: key)
            a.values = values; a.keyTimes = times.map(unit); a.calculationMode = discrete ? .discrete : .linear
            a.duration = length; a.beginTime = begin; a.fillMode = .both; a.isRemovedOnCompletion = false
            to.add(a, forKey: key)
        }
        let cells = plan.cells.isEmpty ? [] : plan.cells + [plan.cells.last!]
        let cellTimes = plan.cells.map { $0.time } + [plan.duration]
        add(layer, "contents", cells.compactMap { stagePose?.image ?? character.images[$0.entry.sheet] }, cellTimes, discrete: true)
        add(layer, "contentsRect", cells.map { NSValue(rect: PerchPlan.rect($0.entry, $0.column, cell: cell)) }, cellTimes, discrete: true)
        add(layer, "transform", cells.map { NSValue(caTransform3D: CATransform3DMakeScale($0.entry.scale * ($0.entry.flip ? -1 : 1), $0.entry.scale, 1)) }, cellTimes, discrete: true)
        let flipAt = { (t: Double) in plan.cell(at: t)?.entry ?? cells[0].entry }
        add(layer, "position", plan.positions.map { local($0.1, flipAt($0.0)) }, plan.positions.map { $0.0 }, discrete: plan.reduced)
        if !plan.opacity.isEmpty { add(layer, "opacity", plan.opacity.map { NSNumber(value: $0.1) }, plan.opacity.map { $0.0 }, discrete: false) }
        if let text = character.frame.sessionBadge {
            let badge = sessionBadgeLayer(text, scale: panel.screen?.backingScaleFactor ?? 2)
            root.addSublayer(badge)
            add(badge, "position", plan.positions.map { NSValue(point: CGPoint(x: $0.1.x - target.minX + metrics.size.width - 16, y: $0.1.y - target.minY)) }, plan.positions.map { $0.0 }, discrete: plan.reduced)
            if !plan.opacity.isEmpty { add(badge, "opacity", plan.opacity.map { NSNumber(value: $0.1) }, plan.opacity.map { $0.0 }, discrete: false) }
        }
        if Set(plan.masked.map { $0.1 }).count > 1 {
            add(mask, "bounds", plan.masked.map { NSValue(rect: $0.1 ? cut : whole) }, plan.masked.map { $0.0 }, discrete: true, path: "mask.bounds")
        }
        zs = nil
        if plan.zs, let last = plan.positions.last?.1 {
            root.addSublayer(perchZs(at: CGPoint(x: last.x - target.minX + metrics.size.width / 2 + 8, y: last.y - target.minY + 10), begin: begin, still: plan.zsStill))
        }
        CATransaction.commit()
        if !panel.isVisible { panel.orderFrontRegardless() }
#if SLEIGHT_STAGE_BENCH
        stageBenchInstalled?(self, plan, metrics, stagePose, (CACurrentMediaTime() - stageBenchBegan) * 1000)
#endif
        let body = plan.positions.last.map { CGRect(origin: $0.1, size: metrics.size) }
        host?.showCharacterBadge(body, after: plan.duration, pid: plan.seat.pid, window: plan.seat.window) { [weak self, weak panel] in
            self?.panel === panel && panel?.isVisible == true
        }
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
        host?.pauseOverlay.hide(owner: panel)
        guard let root = root else { release(); return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = root.opacity; a.toValue = 0; a.duration = duration
        root.opacity = 0; root.add(a, forKey: "fade")
        CATransaction.commit()
        let mine = root
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in if self?.root === mine { self?.release() } }
    }
    func release() {
#if SLEIGHT_CALL_SELFTEST
        callTestVisible = false
#endif
        host?.pauseOverlay.hide(owner: panel)
        root?.removeAllAnimations(); root?.removeFromSuperlayer(); root = nil; boxLayer = nil; maskLayer = nil; zs = nil
        panelLifetime.release(); frame = .null
        stageSlot.release()
    }
    // The white comic bubble in its own click panel, the only part of the overlay that takes a click.
    func showBubble(_ line: PerchLine) {
        closeBubble()
        let b = line.bubble, panel = PerchBubblePanel(contentRect: appKitRect(b.frame.insetBy(dx: -7, dy: -7)), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.level = .floating; panel.hasShadow = false; panel.isOpaque = false; panel.backgroundColor = .clear
        panel.sharingType = handCaptureModes[host?.capture ?? "hidden"] ?? NSWindow.SharingType.none
        panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]; panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false; panel.animationBehavior = .none; panel.setAccessibilityElement(false)
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
func perchWorld(pid: Int32, window: UInt32, snapshot: [[String: Any]]? = nil) -> PerchWorld? {
    guard let list = snapshot ?? (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) else { return nil }
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

// BEGIN STAGE
func sessionBadgeLayer(_ text: String, scale: CGFloat) -> CATextLayer {
    let layer = CATextLayer(); layer.name = "session-badge"; layer.anchorPoint = .zero
    layer.bounds = CGRect(x: 0, y: 0, width: 16, height: 16); layer.cornerRadius = 8
    layer.backgroundColor = CGColor(gray: 0.12, alpha: 0.9); layer.foregroundColor = CGColor(gray: 1, alpha: 1)
    layer.borderWidth = 1; layer.borderColor = CGColor(gray: 1, alpha: 1)
    layer.string = text; layer.fontSize = 11; layer.alignmentMode = .center; layer.contentsScale = scale
    return layer
}
// BEGIN STAGE SLOT
// Owner decision 7, reversible in one place. Lock inodes remain: unlinking a held flock could admit two hosts.
let oneStagePerDisplay = true
final class StageSlot {
    let root: String
    private var descriptor: Int32 = -1
    private var directoryDescriptor: Int32 = -1
    private var directoryLinks: [(parent: Int32, name: String, device: dev_t, inode: ino_t)] = []
    private(set) var display: String?
    init(root: String = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/sleight/cursor/sessions").path) { self.root = root }
    private func valid(_ s: stat) -> Bool {
        s.st_uid == getuid() && s.st_nlink == 1 && s.st_mode & S_IFMT == S_IFREG && s.st_mode & 0o7777 == 0o600
    }
    private func directory() -> Int32 {
        if directoryDescriptor >= 0 {
            // Keep the descriptors, but prove every named ancestor still leads to the acquired directory.
            // A rename, replacement or symlink must refuse admission just as a fresh O_NOFOLLOW walk does.
            for link in directoryLinks {
                var named = stat()
                guard fstatat(link.parent, link.name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                    named.st_mode & S_IFMT == S_IFDIR, named.st_dev == link.device, named.st_ino == link.inode else {
                    closeDirectories(); return -1
                }
            }
            return directoryDescriptor
        }
        let parts = root.split(separator: "/")
        guard root == "/" + parts.joined(separator: "/"), !parts.contains("."), !parts.contains("..") else { return -1 }
        var fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard fd >= 0 else { return -1 }
        for part in parts {
            let name = String(part)
            var next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0 && errno == ENOENT {
                if mkdirat(fd, name, mode_t(0o700)) != 0 && errno != EEXIST { close(fd); closeDirectories(); return -1 }
                next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            var child = stat()
            guard next >= 0, fstat(next, &child) == 0 else {
                if next >= 0 { close(next) }; close(fd); closeDirectories(); return -1
            }
            directoryLinks.append((parent: fd, name: name, device: child.st_dev, inode: child.st_ino))
            fd = next
        }
        directoryDescriptor = fd; return fd
    }
    private func closeDirectories() {
        if directoryDescriptor >= 0 { close(directoryDescriptor) }; directoryDescriptor = -1
        for link in directoryLinks { close(link.parent) }
        directoryLinks = []
    }
    func claim(_ key: String) -> Bool {
        guard oneStagePerDisplay else { return true }
        guard let number = UInt32(key), number > 0, String(number) == key else { return false }
        // The panel owner must order out before releasing an old display, even on a failed claim.
        guard descriptor < 0 || display == key else { return false }
        let dir = directory()
        guard dir >= 0 else { return false }
        defer { if descriptor < 0 { closeDirectories() } }
        var folder = stat()
        guard fstat(dir, &folder) == 0, folder.st_uid == getuid(), folder.st_mode & 0o7777 == 0o700 else { return false }
        let name = "stage-\(key).lock"
        var named = stat(), current = stat()
        if descriptor >= 0 {
            guard fstat(descriptor, &current) == 0, fstatat(dir, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                valid(current), valid(named), current.st_dev == named.st_dev, current.st_ino == named.st_ino else { return false }
            return true
        }
        let fd = openat(dir, name, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, mode_t(0o600))
        guard fd >= 0 else { return false }
        guard fstat(fd, &current) == 0, fstatat(dir, name, &named, AT_SYMLINK_NOFOLLOW) == 0,
            valid(current), valid(named), current.st_dev == named.st_dev, current.st_ino == named.st_ino,
            flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); return false }
        descriptor = fd; display = key; return true
    }
    func release() { if descriptor >= 0 { close(descriptor) }; descriptor = -1; display = nil; closeDirectories() }
    deinit { release() }
}
// END STAGE SLOT
// Stage placement wraps the A2 pose builder. Geometry uses whole boxes, including transparent padding, so a missing
// silhouette measurement can only hide a character. The dump and the host supply the same metadata-only world.
struct StageOptions {
    var size = "medium", points: Double? = nil, attention = true, frontSit = false
    var enabled: Bool { size != "small" || points != nil }
    static func parse(_ data: [String: Any]) -> StageOptions? {
        var value = StageOptions()
        if let raw = data["size"] {
            if let s = raw as? String, ["small", "medium", "stage"].contains(s) { value.size = s }
            else if let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, (104...560).contains(n.doubleValue) {
                value.size = "stage"; value.points = n.doubleValue
            } else { return nil }
        }
        for key in ["stageAttention", "stageFrontSit"] where data[key] != nil {
            guard let n = data[key] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
            if key == "stageAttention" { value.attention = n.boolValue } else { value.frontSit = n.boolValue }
        }
        return value
    }
}
func stageWindowEdgeDifference(_ a: CGRect, _ b: CGRect) -> Double {
    max(abs(a.minX - b.minX), abs(a.minY - b.minY), abs(a.maxX - b.maxX), abs(a.maxY - b.maxY))
}
func stageSameWindowBounds(_ a: CGRect, _ b: CGRect) -> Bool { stageWindowEdgeDifference(a, b) <= 2 }
// Seating tolerates the two CG frame sources. Target provenance still widens
// protection for any measured mismatch beyond floating-point roundoff.
func stageSameTargetBounds(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 0.01 && abs(a.minY - b.minY) <= 0.01 && abs(a.width - b.width) <= 0.01 && abs(a.height - b.height) <= 0.01
}
struct StageWindowKey: Hashable { var pid: Int32, window: UInt32 }
struct StageWindowEpoch: Equatable { var bounds: CGRect, generation: Int, content: Int = 0 }
// Local frame provenance cannot establish action completion or result consumption.
struct StageContributor: Equatable { var seq: Int, state: String, content: Int }
struct StageTarget { var box: CGRect, key: StageWindowKey, epoch: StageWindowEpoch, contributors: [StageContributor] = []; var outside = false }
struct StageWindowBook {
    var current: [StageWindowKey: StageWindowEpoch] = [:], serial = 0, overflow = false
    var discontinuous: Set<StageWindowKey> = []
    mutating func observe(_ windows: [StageWindowKey: CGRect]) {
        if windows.count > 128 { overflow = true }
        for key in current.keys where windows[key] == nil {
            if discontinuous.count < 128 { discontinuous.insert(key) } else { overflow = true }
        }
        var next: [StageWindowKey: StageWindowEpoch] = [:]
        for key in windows.keys.sorted(by: { $0.pid == $1.pid ? $0.window < $1.window : $0.pid < $1.pid }).prefix(128) {
            let bounds = windows[key]!
            // A visibility gap breaks continuity, including an equal-bounds PID/window reuse.
            if let old = current[key], stageSameWindowBounds(old.bounds, bounds) { next[key] = old }
            else { serial += 1; next[key] = StageWindowEpoch(bounds: bounds, generation: serial, content: current[key]?.content ?? 0) }
        }
        current = next
    }
    mutating func contentChanged(_ key: StageWindowKey) {
        guard var epoch = current[key] else { return }
        epoch.content += 1; current[key] = epoch
    }
}
func stageWidePids(_ names: Set<String>, snapshot: [[String: Any]], bundle: (Int32) -> String? = { _ in nil }) -> Set<Int32> {
    guard !names.isEmpty else { return [] }
    var pids: Set<Int32> = [], bundles: [Int32: String] = [:]
    for item in snapshot {
        guard let pid = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid > 0 else { continue }
        if pids.contains(pid) { continue }
        let owner = item[kCGWindowOwnerName as String] as? String ?? ""
        if names.contains(where: { $0.caseInsensitiveCompare(owner) == .orderedSame }) { pids.insert(pid); continue }
        let identity = bundles[pid] ?? bundle(pid) ?? ""; bundles[pid] = identity
        if names.contains(where: { $0.caseInsensitiveCompare(identity) == .orderedSame }) { pids.insert(pid) }
    }
    return pids
}
func stageWindows(_ list: [[String: Any]], areaApps: Set<Int32> = []) -> [StageWindowKey: CGRect] {
    var windows: [StageWindowKey: CGRect] = [:]
    for info in list {
        if let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
            layer == 0 || areaApps.contains(pid),
            let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
            let raw = info[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), stageRectValid(bounds) {
            windows[StageWindowKey(pid: pid, window: id)] = bounds
        }
    }
    return windows
}
struct StageWorld {
    var base: PerchWorld, usable: CGRect, person: CGRect?, pointer: CGPoint, inputAge: Double, pointerAway: Double
    var windows: [StageWindowKey: CGRect]? = nil
    // Front to back, from the same layer-0 snapshot as windows. Dictionaries cannot select a drop destination.
    var orderedWindows: [StageWindowKey] = []
    var cards: [CGRect] = [], locked = false, sleeping = false, call = false
    var displayID: String? = nil, stageAvailable = true
    var stopped: Bool { locked || sleeping || call }
}
struct StageSeat {
    var kind: String, box: CGRect, height: Double, rung: String, world: StageWorld, pid: Int32, window: UInt32
    var art: SpriteStagePose? = nil
}
struct StageDraw {
    var pose: PerchPlan, seat: StageSeat, metrics: PerchMetrics, seq: Int, fallback: Bool, dodgeMs = 0.0
    var decisionReason: String? = nil
    var art: SpriteStagePose? = nil
    var seatLine = 0.0
    var panelPolicy = stagePanelSnapshot()
}
enum StageEffect { case draw(StageDraw), reseat(CGPoint), hide(String, Double), park }
func stagePanelFrameAccepted(target: CGRect, actual: CGRect) -> Bool { target == actual }
func stagePanelBounds(_ plan: PerchPlan, _ metrics: PerchMetrics) -> CGRect {
    let extent = plan.positions.reduce(CGRect.null) { $0.union(CGRect(origin: $1.1, size: metrics.size)) }
    // Stage art already fits inside the admitted cell. Transparent padding can cover a protected
    // area and AppKit can move that enlarged panel back onto the display. Keep the real panel in it.
    // AppKit floors the origin and ceils the size independently. Plan with a whole-point
    // enclosing rectangle so its real frame is exact and remains part of every clearance check.
    return extent.integral.intersection(plan.seat.usable ?? plan.seat.display)
}
// BEGIN SPRITE DRAWING BOUNDS
// AppKit floors the origin and ceils size in its bottom-left coordinates.
// Return the resulting top-left displacement of the original layer contents.
func spritePanelRoundingOffset(_ appKit: CGRect) -> CGPoint {
    CGPoint(x: floor(appKit.minX) - appKit.minX, y: appKit.maxY - floor(appKit.minY) - ceil(appKit.height))
}
// The renderer samples a half-texel-inset contentsRect across the original cell.
// Include the linear filter's support, then round outward to whole screen points.
// No image, frame rectangle, layer scale or animation is resampled or rewritten.
func spriteDrawingBounds(_ positions: [CGPoint], size: CGSize, cell: CGSize, ink: CGRect, flips: [Bool], clip: CGRect) -> CGRect {
    guard !ink.isNull, !ink.isEmpty, cell.width > 1, cell.height > 1 else { return clip }
    let extent = spriteInkUnion(positions, size: size, cell: cell, ink: ink, flips: flips, filter: true)
    let cropped = extent.integral.intersection(clip)
    return cropped.isNull || cropped.isEmpty ? clip : cropped
}
func spriteInkUnion(_ positions: [CGPoint], size: CGSize, cell: CGSize, ink: CGRect, flips: [Bool], filter: Bool) -> CGRect {
    guard !ink.isNull, !ink.isEmpty, cell.width > 1, cell.height > 1 else { return .null }
    let support: CGFloat = filter ? 1 : 0
    let x0 = max(0, (ink.minX - support) * cell.width / (cell.width - 1))
    let y0 = max(0, (ink.minY - support) * cell.height / (cell.height - 1))
    let x1 = min(cell.width, (ink.maxX + support) * cell.width / (cell.width - 1))
    let y1 = min(cell.height, (ink.maxY + support) * cell.height / (cell.height - 1))
    var extent = CGRect.null
    for flip in Set(flips) {
        let left = flip ? cell.width - x1 : x0
        let local = CGRect(x: left * size.width / cell.width, y: y0 * size.height / cell.height,
            width: (x1 - x0) * size.width / cell.width, height: (y1 - y0) * size.height / cell.height)
        for point in positions { extent = extent.union(local.offsetBy(dx: point.x, dy: point.y)) }
    }
    return extent
}
// END SPRITE DRAWING BOUNDS
// BEGIN SPRITE PANEL GEOMETRY
struct SpritePanelGeometry {
    let target: CGRect, inkUnion: CGRect, filterUnion: CGRect, clip: CGRect, required: CGRect
    let positions: Int, geometries: Int, hasExtras: Bool
    func offsetBy(_ delta: CGPoint) -> SpritePanelGeometry {
        func shift(_ r: CGRect) -> CGRect { r.offsetBy(dx: delta.x, dy: delta.y) }
        return SpritePanelGeometry(target: shift(target), inkUnion: shift(inkUnion), filterUnion: shift(filterUnion),
            clip: shift(clip), required: shift(required), positions: positions, geometries: geometries, hasExtras: hasExtras)
    }
    var json: [String: Any] {
        ["inkUnion": stageTraceRect(inkUnion), "filterUnion": stageTraceRect(filterUnion), "clip": stageTraceRect(clip),
            "required": stageTraceRect(required), "positions": positions, "geometries": geometries, "hasExtras": hasExtras]
    }
}
private struct SpritePanelPoseKey: Hashable { let sheet: String, scale: Double, flip: Bool }
func spritePanelGeometry(_ plan: PerchPlan, metrics: PerchMetrics, cell: CGSize, logicalPanel: CGRect,
    offset: CGPoint, clip: CGRect, hasExtras: Bool, inkFor: (String) -> CGRect) -> SpritePanelGeometry {
    var target = CGRect.null, inkUnion = CGRect.null, filterUnion = CGRect.null
    var seen = Set<SpritePanelPoseKey>()
    // Every frame of the same sheet, scale and flip has the same conservative
    // decoded ink bounds. Compute that geometry once, across every motion point.
    for pose in plan.cells {
        guard seen.insert(SpritePanelPoseKey(sheet: pose.entry.sheet, scale: pose.entry.scale, flip: pose.entry.flip)).inserted else { continue }
        let size = CGSize(width: cell.width * pose.entry.scale, height: cell.height * pose.entry.scale)
        let positions = plan.positions.map { CGPoint(x: $0.1.x + offset.x + (pose.entry.flip ? metrics.size.width - size.width : 0), y: $0.1.y + offset.y) }
        let ink = inkFor(pose.entry.sheet)
        inkUnion = inkUnion.union(spriteInkUnion(positions, size: size, cell: cell, ink: ink, flips: [pose.entry.flip], filter: false))
        filterUnion = filterUnion.union(spriteInkUnion(positions, size: size, cell: cell, ink: ink, flips: [pose.entry.flip], filter: true))
        target = target.union(spriteDrawingBounds(positions, size: size, cell: cell, ink: ink, flips: [pose.entry.flip], clip: clip))
    }
    // The pre-existing logical clip still admits the motion. The new physical
    // panel must contain every pixel it previously drew, including filter support.
    // Decorations retain their original full drawing envelope, including glyph
    // strokes and motion. They never qualify from the sprite's ink alone.
    let required = hasExtras ? clip : filterUnion.intersection(clip)
    return SpritePanelGeometry(target: hasExtras ? logicalPanel : target, inkUnion: inkUnion, filterUnion: filterUnion,
        clip: clip, required: required, positions: plan.positions.count, geometries: seen.count, hasExtras: hasExtras)
}
// END SPRITE PANEL GEOMETRY
func stageAreaEvent(_ incoming: RingEvent, windows: [StageWindowKey: CGRect]) -> PerchEvent {
    let key = incoming.windowId == 0 ? windows.keys.filter { $0.pid == incoming.pid }.sorted { $0.window < $1.window }.first :
        StageWindowKey(pid: incoming.pid, window: incoming.windowId)
    let bounds = key.flatMap { windows[$0] }
    return PerchEvent(state: incoming.state, pid: incoming.pid, window: key?.window ?? 0,
        at: bounds.map { CGPoint(x: $0.midX, y: $0.midY) } ?? .zero, ok: incoming.ok, drop: nil, end: nil,
        windowRect: incoming.windowRect, area: incoming.area)
}
func stageAreaEvent(_ incoming: RingEvent, snapshot: [[String: Any]]) -> PerchEvent {
    stageAreaEvent(incoming, windows: stageWindows(snapshot, areaApps: [incoming.pid]))
}
func stageInputAge() -> Double {
    [CGEventType.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel,
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged].map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? 0
}
func stageRectValid(_ r: CGRect) -> Bool {
    [r.minX, r.minY, r.width, r.height].allSatisfy { $0.isFinite && abs($0) <= 100000 } && r.size.width > 0 && r.size.height > 0
}
func stagePointRect(_ p: CGPoint, _ radius: Double) -> CGRect { CGRect(x: p.x - radius, y: p.y - radius, width: radius * 2, height: radius * 2) }
func stageDistance(_ p: CGPoint, _ r: CGRect) -> Double {
    hypot(max(r.minX - p.x, 0, p.x - r.maxX), max(r.minY - p.y, 0, p.y - r.maxY))
}
// Opt-in bounded transaction journal. It contains geometry and fixed state names only.
// The benchmark enables it; normal hosts allocate no journal or JSON records.
final class StageTrace {
    var rows: [[String: Any]] = [], bytes = 0, overflow = false
    var imageIDs: [ObjectIdentifier: Int] = [:]
    let limit: Int
    init(limit: Int = 2 * 1024 * 1024) { self.limit = limit }
    func append(_ input: [String: Any], _ output: [String: Any] = [:]) {
        guard !overflow else { return }
        if let windows = input["windows"] as? [[String: Any]], windows.count > 128 { overflow = true; return }
        if let world = input["world"] as? [String: Any],
            (world["windows"] as? [Any] ?? []).count > 128 || (world["above"] as? [Any] ?? []).count > 128 || (world["cards"] as? [Any] ?? []).count > 128 {
            overflow = true; return
        }
        let row: [String: Any] = ["order": rows.count, "input": input, "output": output]
        guard let data = try? JSONSerialization.data(withJSONObject: row), rows.count < 16384, bytes + data.count <= limit else { overflow = true; return }
        bytes += data.count; rows.append(row)
    }
    func art(_ pose: SpriteStagePose) -> [String: Any] {
        let key = ObjectIdentifier(pose.image)
        if imageIDs[key] == nil {
            guard imageIDs.count < 4096 else { overflow = true; return [:] }
            imageIDs[key] = imageIDs.count
        }
        return pose.traceJSON.merging(["image": imageIDs[key]!]) { $1 }
    }
    var json: [String: Any] { ["schema": "sleight.stage-trace/1", "complete": !overflow, "bytes": bytes, "records": rows] }
}
func stageTraceRect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
func stageTraceWindows(_ windows: [StageWindowKey: CGRect]) -> [[String: Any]] {
    windows.keys.sorted { $0.pid == $1.pid ? $0.window < $1.window : $0.pid < $1.pid }.map {
        ["pid": $0.pid, "id": $0.window, "frame": stageTraceRect(windows[$0]!)]
    }
}
extension StageWorld {
    var traceJSON: [String: Any] {
        ["window": stageTraceRect(base.window), "above": base.above.map(stageTraceRect), "display": stageTraceRect(base.display),
            "top": base.top, "fullScreen": base.fullScreen, "usable": stageTraceRect(usable),
            "person": person.map(stageTraceRect) as Any? ?? NSNull(), "pointer": [pointer.x, pointer.y],
            "inputAge": inputAge, "pointerAway": pointerAway, "windows": windows.map(stageTraceWindows) as Any? ?? NSNull(),
            "orderedWindows": orderedWindows.map { ["pid": $0.pid, "id": $0.window] },
            "cards": cards.map(stageTraceRect), "locked": locked, "sleeping": sleeping, "call": call,
            "displayID": displayID as Any? ?? NSNull(), "stageAvailable": stageAvailable]
    }
}
extension PerchEvent {
    var traceJSON: [String: Any] {
        ["state": state, "pid": pid, "window": window, "at": [at.x, at.y], "ok": ok,
            "drop": drop as Any? ?? NSNull(), "end": end.map { [$0.x, $0.y] } as Any? ?? NSNull(),
            "windowRect": windowRect.map(stageTraceRect) as Any? ?? NSNull(), "area": area as Any? ?? NSNull(), "wideReason": wideReason as Any? ?? NSNull()]
    }
}
extension SpriteStagePose {
    var traceJSON: [String: Any] {
        ["source": source, "medium": medium, "pending": pending, "cell": [cell.width, cell.height], "anchor": [anchor.x, anchor.y],
            "filter": filter, "entry": ["sheet": entry.sheet, "row": entry.row, "frames": entry.columns, "ms": entry.ms,
                "loop": entry.loop, "flip": entry.flip, "hotspot": [entry.hotspot.x, entry.hotspot.y],
                "size": [entry.size?.width ?? cell.width * 8, entry.size?.height ?? cell.height], "scale": entry.scale]]
    }
}
// A geometry witness is private metadata from an observing producer, never a timer, delta or completion.
// Ordinary hand frames carry no such witness and cannot unlock an uncertain window.
struct StageGeometryReference {
    var seq: Int, rects: [CGRect], departed: Bool
}
struct StageGeometryObservation {
    var key: StageWindowKey, incarnation: String, observation: Int, content: Int, after: Int, mode: String, bounds: CGRect
    var references: [StageGeometryReference]
    var json: [String: Any] {
        ["pid": key.pid, "windowId": key.window, "incarnation": incarnation, "observation": observation,
            "contentGeneration": content, "after": after, "mode": mode, "bounds": stageTraceRect(bounds),
            "references": references.map { ["seq": $0.seq, "rects": $0.rects.map(stageTraceRect), "departed": $0.departed] as [String: Any] }]
    }
    static func parse(_ data: [String: Any]) -> StageGeometryObservation? {
        func int(_ raw: Any?, _ range: ClosedRange<Int>) -> Int? {
            guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                n.doubleValue.rounded() == n.doubleValue, Double(range.lowerBound) <= n.doubleValue,
                n.doubleValue <= Double(range.upperBound) else { return nil }; return n.intValue
        }
        func rect(_ raw: Any?) -> CGRect? {
            guard let a = raw as? [NSNumber], a.count == 4,
                a.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && abs($0.doubleValue) <= 100000 }) else { return nil }
            let r = CGRect(x: a[0].doubleValue, y: a[1].doubleValue, width: a[2].doubleValue, height: a[3].doubleValue)
            return stageRectValid(r) ? r : nil
        }
        guard Set(data.keys) == ["pid", "windowId", "incarnation", "observation", "contentGeneration", "after", "mode", "bounds", "references"],
            let pid = int(data["pid"], 1...2147483647), let window = int(data["windowId"], 1...4294967295),
            let incarnation = data["incarnation"] as? String, incarnation.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
            let observation = int(data["observation"], 0...9007199254740991), let content = int(data["contentGeneration"], 0...9007199254740991),
            let after = int(data["after"], -1...9007199254740991), let mode = data["mode"] as? String, ["baseline", "move", "scroll"].contains(mode),
            let bounds = rect(data["bounds"]), let refs = data["references"] as? [[String: Any]], refs.count <= 512 else { return nil }
        var references: [StageGeometryReference] = []
        for raw in refs {
            guard Set(raw.keys) == ["seq", "rects", "departed"], let seq = int(raw["seq"], 0...9007199254740991),
                let rs = raw["rects"] as? [Any], rs.count <= 4, let flag = raw["departed"] as? NSNumber,
                CFGetTypeID(flag) == CFBooleanGetTypeID(), flag.boolValue ? rs.isEmpty : !rs.isEmpty else { return nil }
            let boxes = rs.compactMap(rect); guard boxes.count == rs.count else { return nil }
            references.append(StageGeometryReference(seq: seq, rects: boxes, departed: flag.boolValue))
        }
        guard Set(references.map { $0.seq }).count == references.count else { return nil }
        return StageGeometryObservation(key: StageWindowKey(pid: Int32(pid), window: UInt32(window)), incarnation: incarnation,
            observation: observation, content: content, after: after, mode: mode, bounds: bounds, references: references)
    }
}
func stageGeometryFrame(_ data: [String: Any]) -> (String, Int, StageGeometryObservation)? {
    guard Set(data.keys) == ["hand", "nonce", "seq", "geometry"], data["hand"] as? String == "stage-geometry",
        let nonce = data["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
        let seq = data["seq"] as? NSNumber, CFGetTypeID(seq) != CFBooleanGetTypeID(), seq.doubleValue.isFinite,
        seq.doubleValue.rounded() == seq.doubleValue, (0...9007199254740991).contains(seq.doubleValue),
        let raw = data["geometry"] as? [String: Any], let proof = StageGeometryObservation.parse(raw) else { return nil }
    return (nonce, seq.intValue, proof)
}

// Private parent transport. Public cursor frames cannot carry these fields.
func writeStageProducerAck(_ ack: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: ack) { FileHandle.standardOutput.write(bytes + Data([10])) }
}
struct StageProducerPrefix: Equatable {
    var call: String, action: Int, attempt: Int, ordinal: Int
    static func parse(_ raw: Any?) -> StageProducerPrefix? {
        guard let d = raw as? [String: Any], Set(d.keys) == ["call", "action", "attempt", "ordinal"],
            let call = producerToken(d["call"]), let action = producerInt(d["action"], minimum: 1),
            let attempt = producerInt(d["attempt"], minimum: 1), let ordinal = producerInt(d["ordinal"], minimum: 1) else { return nil }
        return StageProducerPrefix(call: call, action: action, attempt: attempt, ordinal: ordinal)
    }
}
struct StageProducerIdentity: Equatable { var session: String, turn: String }
func producerInt(_ raw: Any?, minimum: Int = 0) -> Int? {
    guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
        n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= Double(minimum), n.doubleValue <= 9007199254740991 else { return nil }
    return n.intValue
}
func producerToken(_ raw: Any?) -> String? {
    guard let s = raw as? String, s.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil else { return nil }; return s
}
struct StageProducerFrame {
    var nonce: String, session: String, turn: String, seq: Int, op: String
    var prefix: StageProducerPrefix?, after = -1, epoch = 0, observation = 0, acquired: [Double] = []
    var target: RingEvent?, geometry: StageGeometryObservation?, barrier = 0.0
    static func parse(_ d: [String: Any], bytes: Int) -> StageProducerFrame? {
        guard bytes <= 65536, d["hand"] as? String == "stage-producer",
            let nonce = d["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
            let session = producerToken(d["session"]), let turn = producerToken(d["turn"]),
            let seq = producerInt(d["seq"]), let op = d["op"] as? String else { return nil }
        let common: Set<String> = ["hand", "nonce", "session", "turn", "seq", "op"]
        var f = StageProducerFrame(nonce: nonce, session: session, turn: turn, seq: seq, op: op)
        if ["begin", "admit", "invalidate"].contains(op) {
            guard let n = d["barrier"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, n.doubleValue >= 0 else { return nil }
            f.barrier = n.doubleValue
        }
        switch op {
        case "begin": guard Set(d.keys) == common.union(["barrier"]) else { return nil }
        case "end", "fault": guard Set(d.keys) == common else { return nil }
        case "public":
            guard Set(d.keys) == common.union(["frame"]), var raw = d["frame"] as? [String: Any],
                raw["nonce"] == nil, raw["seq"] == nil else { return nil }
            raw["nonce"] = nonce; raw["seq"] = seq
            guard let parsed = handFrame(raw), case let .status(_, event) = parsed else { return nil }
            f.target = event
        case "admit":
            guard Set(d.keys) == common.union(["prefix", "frame", "barrier"]), let prefix = StageProducerPrefix.parse(d["prefix"]),
                var raw = d["frame"] as? [String: Any], raw["nonce"] == nil, raw["seq"] == nil else { return nil }
            raw["hand"] = raw["hand"] ?? "act"; raw["nonce"] = nonce; raw["seq"] = seq
            guard let parsed = handFrame(raw) else { return nil }
            switch parsed { case let .act(_, act): f.target = ringEvent(act)
                case let .aim(_, event): f.target = event
                default: return nil }
            f.prefix = prefix
        case "invalidate", "certificate":
            let extra: Set<String> = op == "invalidate" ? ["epoch", "after", "prefix", "reason", "barrier"] : ["epoch", "after", "prefix", "observation", "acquired", "geometry"]
            guard Set(d.keys) == common.union(extra), let epoch = producerInt(d["epoch"]),
                let after = producerInt(d["after"], minimum: -1) else { return nil }
            f.epoch = epoch; f.after = after
            if d["prefix"] is NSNull { f.prefix = nil }
            else { guard let prefix = StageProducerPrefix.parse(d["prefix"]) else { return nil }; f.prefix = prefix }
            if op == "invalidate" {
                guard let reason = d["reason"] as? String, ["layout", "resize", "typing", "navigation", "ambient", "scroll"].contains(reason) else { return nil }
            } else {
                guard let observation = producerInt(d["observation"], minimum: 1), let acquired = d["acquired"] as? [NSNumber],
                    acquired.count == 2, acquired.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && $0.doubleValue >= 0 }),
                    acquired[0].doubleValue <= acquired[1].doubleValue, var raw = d["geometry"] as? [String: Any],
                    Set(raw.keys) == ["pid", "windowId", "incarnation", "contentGeneration", "mode", "bounds", "references"] else { return nil }
                let layout = raw["mode"] as? String == "layout"
                if layout { raw["mode"] = "scroll" }
                raw["observation"] = observation; raw["after"] = after
                guard var geometry = StageGeometryObservation.parse(raw) else { return nil }
                if layout { geometry.mode = "layout" }
                f.geometry = geometry; f.observation = observation; f.acquired = acquired.map { $0.doubleValue }
            }
        default: return nil
        }
        return f
    }
}
struct StageProducerState {
    var session: String?, turn: String?, ended: [String] = [], last = -1, epoch = 0, after = -1, observation = 0
    var prefix: StageProducerPrefix?, failed = false, baselineLost = false, acquiredEnd = -1.0, barrier = 0.0
    var references: [Int: StageWindowKey] = [:], attempts: [StageProducerPrefix] = []
    var baselines: [StageWindowKey: String] = [:], contents: [StageWindowKey: Int] = [:]
    var observations: [StageWindowKey: StageGeometryObservation] = [:]
    var endedIdentities: [StageProducerIdentity] = []
    var active: Bool { turn != nil }
    var identity: StageProducerIdentity? {
        guard let session = session, let turn = turn else { return nil }
        return StageProducerIdentity(session: session, turn: turn)
    }
    mutating func finish() {
        var recent = ended
        var identities = endedIdentities
        if let identity = identity { identities.append(identity) }
        if identities.count > 512 { identities.removeFirst(identities.count - 512) }
        if let turn = turn { recent.append(turn) }
        if recent.count > 512 { recent.removeFirst(recent.count - 512) }
        let sequence = last
        self = StageProducerState(); ended = recent; endedIdentities = identities; last = sequence
    }
}

struct StageRuntime {
    var trace: StageTrace?, traceDepth = 0, traceInput: [String: Any]?, traceArt: [[String: Any]] = []
    mutating func beginTrace(_ op: String, now: Double, world: StageWorld? = nil, reduced: Bool = false, extra: @autoclosure () -> [String: Any] = [:]) {
        guard trace != nil else { return }
        if traceDepth == 0 {
            traceArt = []
            traceInput = ["op": op, "now": now, "world": world?.traceJSON as Any? ?? NSNull(), "reduced": reduced,
                "flags": ["carrying": carrying, "carryUntil": carryUntil, "held": held, "paused": paused,
                    "locked": locked, "sleeping": displaySleeping, "badgeApproach": badgeApproach, "stageArt": stageArt],
                "provider": artProvider != nil].merging(extra()) { _, new in new }
        }
        traceDepth += 1
    }
    mutating func endTrace() {
        guard let trace = trace else { return }
        traceDepth -= 1
        if traceDepth == 0, var input = traceInput {
            input["art"] = traceArt
            trace.append(input, ["turnTargets": turnTargets.count, "contributors": turnTargets.reduce(0, { $0 + $1.contributors.count }),
                "shown": shown, "hiddenReason": hiddenReason as Any? ?? NSNull(), "seq": seq, "planBegan": planBegan,
                "draw": shown ? draw.map { $0.json(base.frame?.cell ?? .zero, time: input["now"] as! Double) } as Any? ?? NSNull() : NSNull()])
            traceInput = nil
        }
    }
    mutating func selectArt(_ state: String) -> SpriteStagePose? {
        let pose = artProvider?(state)
        if trace != nil && traceDepth > 0 { traceArt.append(["state": state, "pose": pose.map { trace!.art($0) } as Any? ?? NSNull()]) }
        return pose
    }
    mutating func observeWindows(_ windows: [StageWindowKey: CGRect]) {
        if traceDepth == 0 { trace?.append(["op": "windows", "windows": stageTraceWindows(windows)]) }
        windowBook.observe(windows)
        for key in windows.keys where wideApps.contains(key.pid) { invalidateGeometry(key) }
    }

    var base = PerchRuntime(), options = StageOptions(size: "small"), seat: StageSeat?, draw: StageDraw?, shown = false
    // The production provider uses ST3's lazy cache. The geometry-only dump can also test large seats without decoding art.
    var artPose: SpriteStagePose?
    var artProvider: ((String) -> SpriteStagePose?)?
    func artState(for kind: String) -> String {
        if paused { return "stage-paused" }; if asleep { return "stage-sleep" }
        if reaction == "error" { return "stage-wince" }; if reaction == "waiting" { return "stage-wait" }
        if carrying { return "stage-carry" }
        if ["handback", "done"].contains(reaction) { return "stage-handoff" }; if reaction == "turn-success" { return "stage-cheer" }
        if reaction == "thinking" { return "stage-think" }
        if kind == "edge-hang" { return "stage-hang" }
        if kind == "floor-stand" { return "stage-stand" }
        let typing = ["type", "scroll", "drag"].contains(reaction)
        if kind == "corner-hang" { return typing ? "stage-hang-peek" : "stage-hang" }
        if kind == "side-climb" { return "stage-climb" }
        if kind == "desk-stand" { return reaction == "aim" ? "stage-point" : "stage-stand" }
        if ["edge-sit", "front-sit"].contains(kind) { return typing ? "stage-sit-notes" : "stage-sit" }
        return typing ? "stage-lie-peek" : ["click", "double", "right", "key"].contains(reaction) ? "stage-lie-reach" : "stage-lie"
    }
    var carrying = false, carryUntil = 0.0
    var stageArt = false, paused = false, held = false, asleep = false, woke = false
    var badgeApproach = false
    var installedReaction = "perch"
    var reaction = "perch", afterReaction: String? = nil
    var reactionBegan: Double?, reactionUntil: Double?
    var phase: String?, phaseUntil: Double?
    var oneShot: Bool { ["click", "double", "right", "key", "error", "handback", "done", "turn-success"].contains(reaction) }
    var event: PerchEvent?, seq = 0, aimRect: CGRect?, recent: [CGPoint] = []
    var turnTargets: [StageTarget] = [], windowBook = StageWindowBook(), targetCapacity = false
    var wideWindows: Set<StageWindowKey> = [], compactedWindows: Set<StageWindowKey> = []
    var wideApps: Set<Int32> = []
    var wideNames: Set<String> = [], wideEpoch = -1, endedWideEpoch = -1
    mutating func beginWide(_ incoming: RingEvent, windows: [StageWindowKey: CGRect], pids: Set<Int32>) -> PerchEvent? {
        guard let epoch = incoming.wideEpoch, epoch > endedWideEpoch, epoch >= wideEpoch else { return nil }
        wideEpoch = epoch
        if let name = incoming.wideName {
            guard wideNames.count < 128 || wideNames.contains(name) else { targetCapacity = true; return nil }
            wideNames.insert(name)
        }
        if incoming.windowId == 0 {
            guard wideApps.union(pids).count <= 128 else { targetCapacity = true; return nil }
            wideApps.formUnion(pids)
        }
        observeWindows(windows)
        let pid = incoming.pid > 0 ? incoming.pid : pids.sorted().first ?? 0
        var event = incoming
        event = RingEvent(seq: incoming.seq, state: "thinking", pid: pid, windowId: incoming.windowId,
            at: nil, rect: nil, label: nil, area: incoming.area)
        var result = stageAreaEvent(event, windows: windows)
        result.wideReason = incoming.wideReason
        return result
    }
    var terminalSeatUntil: Double? = nil
    var terminalSeen = false
    var wideRecords: [StageWindowKey: CGRect] = [:], wideObservedFrames: [StageWindowKey: CGRect] = [:]
    var pendingDrops: [CGPoint] = []
    var unmappedWindows: Set<StageWindowKey> = [], unmappableDrags: Set<StageWindowKey> = []
    var admissionWatermarks: [StageWindowKey: Int] = [:], geometryObservations: [StageWindowKey: StageGeometryObservation] = [:]
    var requiredReferences: [StageWindowKey: [StageContributor]] = [:]
    var producerCollectionOnly = false
    var producerOwner: StageProducerIdentity?
    var targetUnmapped: Bool { !unmappedWindows.isEmpty }
    mutating func invalidateGeometry(_ key: StageWindowKey) {
        guard wideWindows.count < 128 || wideWindows.contains(key) else { windowBook.overflow = true; targetCapacity = true; return }
        if wideWindows.insert(key).inserted { noSeatWorld = nil }
        // Marking uncertainty can precede the next world bind. Retain the admitted epoch's
        // whole container now, so a later already-wide check cannot skip its old envelope.
        for target in turnTargets where target.key == key && !target.outside {
            retainWide(key, box: target.box.union(target.epoch.bounds.insetBy(dx: -48, dy: -48)))
        }
        if unmappedWindows.count < 128 || unmappedWindows.contains(key) { unmappedWindows.insert(key) }
        else { windowBook.overflow = true; targetCapacity = true }
    }
    mutating func retainWide(_ key: StageWindowKey, box: CGRect) {
        guard wideRecords.count < 128 || wideRecords[key] != nil else { windowBook.overflow = true; targetCapacity = true; return }
        wideRecords[key] = (wideRecords[key] ?? CGRect.null).union(box)
    }
    mutating func widenStale(_ key: StageWindowKey, measured: CGRect, observed: CGRect) {
        let difference = max(abs(measured.minX - observed.minX), abs(measured.minY - observed.minY),
            abs(measured.width - observed.width), abs(measured.height - observed.height))
        maxWindowBoundsDifferencePt = max(maxWindowBoundsDifferencePt ?? 0, difference)
        invalidateGeometry(key)
        retainWide(key, box: measured.union(observed).insetBy(dx: -48, dy: -48))
    }
    // Capacity aggregates retain geometry for the entire turn. They can never accept a shrinking certificate.
    mutating func collapseBusiest() {
        let keys = Set(turnTargets.map { $0.key }).union(requiredReferences.keys)
        guard let key = keys.sorted(by: { a, b in
            let ac = turnTargets.filter { $0.key == a }.count, bc = turnTargets.filter { $0.key == b }.count
            if ac != bc { return ac > bc }
            let ar = requiredReferences[a, default: []].count, br = requiredReferences[b, default: []].count
            if ar != br { return ar > br }
            return a.pid == b.pid ? a.window < b.window : a.pid < b.pid
        }).first else { return }
        let records = turnTargets.filter { $0.key == key && !$0.outside }
        let box = records.reduce(wideRecords[key] ?? CGRect.null) { $0.union($1.box) }
        invalidateGeometry(key)
        if !box.isNull { retainWide(key, box: box) }
        if let frame = windowBook.current[key]?.bounds { retainWide(key, box: frame.insetBy(dx: -48, dy: -48)) }
        compactedWindows.insert(key)
        turnTargets.removeAll { $0.key == key }; requiredReferences.removeValue(forKey: key)
        geometryObservations.removeValue(forKey: key)
    }
    var moving: CGRect?, stableAt: Double?, parkedAt: Double?, lastFrame = 0.0
    var planBegan = 0.0
    var locked = false, displaySleeping = false, hiddenReason: String?
    var pointerEnteredAt: Double?
    var pointerBlocked = false, pointerClearSince: Double?
    var hideReasonCounts: [String: Int] = ["stale-window": 0]
    var maxWindowBoundsDifferencePt: Double?
    var silentReseats = 0, maxSilentReseatDifferencePt = 0.0
    var windowDecisions: [[String: Any]] = []
    var exclusions: [CGRect] = [], forbiddenBuilds = 0
    var noSeatWorld: StageWorld?
    mutating func remember(_ target: CGRect, key: StageWindowKey, epoch: StageWindowEpoch, contributor: StageContributor? = nil) {
        guard !targetCapacity else { return }
        if wideWindows.contains(key) { retainWide(key, box: target) }
        if compactedWindows.contains(key) { return }
        let c = contributor ?? StageContributor(seq: seq, state: event?.state ?? "unknown", content: epoch.content)
        var contributors = [c]
        let same: (StageTarget) -> Bool = { $0.key == key && $0.epoch == epoch && !$0.outside }
        if let index = turnTargets.firstIndex(where: { same($0) && $0.box.contains(target) }) {
            if !turnTargets[index].contributors.contains(c) {
                if turnTargets.reduce(0, { $0 + $1.contributors.count }) >= 512 {
                    collapseBusiest(); remember(target, key: key, epoch: epoch, contributor: c); return
                }
                turnTargets[index].contributors.append(c)
            }
            return
        }
        for old in turnTargets.filter({ same($0) && target.contains($0.box) }) {
            for prior in old.contributors where !contributors.contains(prior) { contributors.append(prior) }
        }
        let remaining = turnTargets.filter { !(same($0) && target.contains($0.box)) }
        if remaining.reduce(contributors.count, { $0 + $1.contributors.count }) > 512 || remaining.count >= 64 {
            collapseBusiest(); remember(target, key: key, epoch: epoch, contributor: c); return
        }
        turnTargets = remaining
        turnTargets.append(StageTarget(box: target, key: key, epoch: epoch, contributors: contributors))
    }
    func validGeometryCertificate(_ proof: StageGeometryObservation, world: StageWorld) -> Bool {
        guard !targetCapacity, !compactedWindows.contains(proof.key), !windowBook.discontinuous.contains(proof.key), !unmappableDrags.contains(proof.key),
            let current = windowBook.current[proof.key], world.windows?[proof.key] == proof.bounds,
            proof.after == admissionWatermarks[proof.key, default: -1] else { return false }
        let targets = turnTargets.filter { $0.key == proof.key }
        if proof.mode == "baseline" {
            return requiredReferences[proof.key, default: []].isEmpty && targets.isEmpty && geometryObservations[proof.key] == nil && proof.references.isEmpty && proof.content == current.content
        }
        guard let prior = geometryObservations[proof.key], prior.incarnation == proof.incarnation,
            proof.observation > prior.observation else { return false }
        let sequences = Set(requiredReferences[proof.key, default: []].map { $0.seq })
        let mapped = Set(proof.references.map { $0.seq }) == sequences &&
            proof.references.allSatisfy { $0.departed || $0.rects.allSatisfy { $0.intersects(proof.bounds) } }
        if proof.mode == "move" {
            guard proof.content == prior.content, proof.content == current.content, proof.bounds.size == prior.bounds.size else { return false }
            // Pure translation requires every old coordinate. A stale admission needs an explicit full mapping.
            if !proof.references.isEmpty { return mapped }
            return Set(targets.flatMap { $0.contributors.map { $0.seq } }) == sequences &&
                targets.allSatisfy { $0.epoch.content == proof.content && $0.epoch.bounds == prior.bounds }
        }
        return proof.content == current.content && proof.content > prior.content && mapped
    }
    mutating func certifyGeometry(_ proof: StageGeometryObservation, now: Double, world: StageWorld?, reduced: Bool) -> [StageEffect] {
        beginTrace("geometry", now: now, world: world, reduced: reduced, extra: ["geometry": proof.json]); defer { endTrace() }
        guard let world = world else { return hide("geometry-unobserved", immediate: true) }
        bindWindows(world)
        guard validGeometryCertificate(proof, world: world) else { invalidateGeometry(proof.key); return hide("geometry-uncertified", immediate: true) }
        guard geometryObservations.count < 128 || geometryObservations[proof.key] != nil else { windowBook.overflow = true; targetCapacity = true; return hide("target-capacity", immediate: true) }
        if proof.mode == "baseline" { geometryObservations[proof.key] = proof; return [] }
        let prior = geometryObservations[proof.key]!, epoch = windowBook.current[proof.key]!
        let translates = proof.mode == "move" && proof.references.isEmpty
        var replacement: [StageTarget] = []
        for var target in turnTargets {
            guard target.key == proof.key else { replacement.append(target); continue }
            if translates {
                target.box = target.box.offsetBy(dx: proof.bounds.minX - prior.bounds.minX, dy: proof.bounds.minY - prior.bounds.minY)
            } else {
                let references = proof.references.filter { ref in target.contributors.contains { $0.seq == ref.seq } }
                var protected: [CGRect] = []
                for reference in references where !reference.departed {
                    for rect in reference.rects {
                        protected.append(rect.insetBy(dx: -48, dy: -48))
                        if rect.minY <= proof.bounds.minY + 56 && rect.maxY >= proof.bounds.minY {
                            protected.append(CGRect(x: rect.minX - 72, y: proof.bounds.minY, width: rect.width + 144, height: 56))
                        }
                    }
                }
                target.outside = protected.isEmpty
                if !protected.isEmpty { target.box = protected.reduce(CGRect.null) { $0.union($1) } }
            }
            target.epoch = epoch
            replacement.append(target)
        }
        let represented = Set(replacement.filter { $0.key == proof.key }.flatMap { $0.contributors.map { $0.seq } })
        for contributor in requiredReferences[proof.key, default: []] where !represented.contains(contributor.seq) {
            guard let reference = proof.references.first(where: { $0.seq == contributor.seq }) else { return hide("geometry-uncertified", immediate: true) }
            let box = reference.rects.map { $0.insetBy(dx: -72, dy: -56) }.reduce(CGRect.null) { $0.union($1) }
            replacement.append(StageTarget(box: reference.departed ? proof.bounds : box, key: proof.key, epoch: epoch,
                contributors: [contributor], outside: reference.departed))
        }
        // Build and validate first. The old geometry stays protected until the whole replacement is ready.
        guard replacement.allSatisfy({ stageRectValid($0.box) }) else { invalidateGeometry(proof.key); return hide("geometry-uncertified", immediate: true) }
        let effects = hide("geometry-remap", immediate: true)
        turnTargets = replacement; geometryObservations[proof.key] = proof; unmappedWindows.remove(proof.key)
        while turnTargets.count > 64 || turnTargets.reduce(0, { $0 + $1.contributors.count }) > 512 { collapseBusiest() }
        noSeatWorld = nil; moving = nil; stableAt = nil
        if let ev = event, ev.pid == proof.key.pid && ev.window == proof.key.window {
            let dx = translates ? proof.bounds.minX - prior.bounds.minX : 0
            let dy = translates ? proof.bounds.minY - prior.bounds.minY : 0
            event = PerchEvent(state: ev.state, pid: ev.pid, window: ev.window, at: CGPoint(x: ev.at.x + dx, y: ev.at.y + dy), ok: ev.ok,
                drop: ev.drop, end: ev.end.map { CGPoint(x: $0.x + dx, y: $0.y + dy) }, detail: ev.detail, retry: ev.retry, transfer: ev.transfer, windowRect: proof.bounds)
            if let rect = aimRect { aimRect = rect.offsetBy(dx: dx, dy: dy) }
        }
        guard let ev = event, ev.pid == proof.key.pid, ev.window == proof.key.window else { return effects }
        return effects + (paused ? [] : observe(now, world: world, reduced: reduced))
    }

    mutating func bindWindows(_ world: StageWorld, acting: StageWindowKey? = nil) {
        if let windows = world.windows { windowBook.observe(windows) }
        else if let ev = event { windowBook.observe([StageWindowKey(pid: ev.pid, window: ev.window): world.base.window]) }
        if windowBook.overflow { targetCapacity = true; return }
        for key in windowBook.current.keys where wideApps.contains(key.pid) { invalidateGeometry(key) }
        var windows = world.windows ?? [:]
        if !world.base.window.isEmpty, let key = acting ?? event.map({ StageWindowKey(pid: $0.pid, window: $0.window) }) { windows[key] = world.base.window }
        // Ordinary frames prove no remapping. Keep old geometry until a complete observation certifies its replacement.
        // A stable seating epoch does not certify that a target moved with it.
        let changed = Set(turnTargets.filter { target in
            windowBook.current[target.key] != target.epoch ||
                windows[target.key].map { !stageSameTargetBounds($0, target.epoch.bounds) } == true
        }.map { $0.key }).subtracting(wideWindows)
        for key in changed {
            for target in turnTargets where target.key == key {
                retainWide(key, box: target.epoch.bounds.insetBy(dx: -48, dy: -48))
            }
            invalidateGeometry(key)
        }
        // An equal-bounds replacement with a new PID is still a new incarnation of the protected window ID.
        for key in windows.keys where !wideWindows.contains(key) && wideWindows.contains(where: { $0.window == key.window }) { invalidateGeometry(key) }
        for key in wideWindows {
            if let old = wideObservedFrames[key], windows[key] != old { retainWide(key, box: old.insetBy(dx: -48, dy: -48)) }
            if let frame = windows[key] {
                wideObservedFrames[key] = frame
            }
        }
        if world.windows != nil && !world.orderedWindows.isEmpty && !pendingDrops.isEmpty {
            let drops = pendingDrops; pendingDrops = []
            for drop in drops { protectDrop(drop, world: world) }
        }
    }
    var activeTargets: [CGRect] { turnTargets.filter { !$0.outside }.map { $0.box } + Array(wideRecords.values) }
    func targetWindows(_ world: StageWorld) -> [StageWindowKey: CGRect] {
        let keys = Set(turnTargets.map { $0.key }).union(wideWindows)
        return (world.windows ?? [:]).filter { keys.contains($0.key) }
    }
    func samePlacementWorld(_ a: StageWorld, _ b: StageWorld) -> Bool {
        a.base.window == b.base.window && a.base.above == b.base.above && a.base.display == b.base.display && a.base.fullScreen == b.base.fullScreen &&
            targetWindows(a) == targetWindows(b) && a.usable == b.usable && a.cards == b.cards && a.person == b.person && a.pointer == b.pointer &&
            (a.inputAge < 8) == (b.inputAge < 8) && (a.pointerAway < 5) == (b.pointerAway < 5) && a.stageAvailable == b.stageAvailable
    }
    mutating func prepare(_ world: StageWorld) { exclusions = forbidden(world); forbiddenBuilds += 1 }
    mutating func load(_ frame: SpriteFrame?) {
        if producerCollectionOnly && !requiredReferences.values.allSatisfy({ $0.isEmpty }) {
            targetCapacity = true; _ = hide("producer-replacement", immediate: true); return
        }
        base.load(frame); options = frame?.stageOptions ?? StageOptions(size: "small"); seat = nil; draw = nil; shown = false
        silentReseats = 0; maxSilentReseatDifferencePt = 0; windowDecisions = []
        artPose = nil
        terminalSeatUntil = nil
        terminalSeen = false
        wideNames = []; wideEpoch = -1; endedWideEpoch = -1
        noSeatWorld = nil; hiddenReason = nil; pointerEnteredAt = nil; pointerBlocked = false; pointerClearSince = nil; exclusions = []; locked = false; displaySleeping = false
        event = nil; recent = []; turnTargets = []; windowBook = StageWindowBook(); targetCapacity = false; wideWindows = []; wideApps = []; compactedWindows = []; wideRecords = [:]; wideObservedFrames = [:]; pendingDrops = []; unmappedWindows = []; unmappableDrags = []; admissionWatermarks = [:]; geometryObservations = [:]; requiredReferences = [:]; aimRect = nil; moving = nil; stableAt = nil; parkedAt = nil; paused = false; held = false; asleep = false; woke = false; reaction = "perch"; afterReaction = nil; reactionBegan = nil; reactionUntil = nil; phase = nil; phaseUntil = nil
    }
    var poll: Double? { event == nil || held || locked || displaySleeping ? nil : asleep || !shown || paused ? 2 : 0.2 }
    // Shared by the real one-shot scheduler and the no-window clock dump.
    func nextWake(_ now: Double) -> (at: Double, source: String)? {
        guard let poll = poll else { return nil }
        let deadlines: [(Double?, String)] = [(now + poll, "stage-window-check"), (reactionUntil, "stage-reaction"),
            (phaseUntil, "stage-phase"), (parkedAt, "stage-park"), (stableAt, "stage-stable"),
            (paused ? nil : lastFrame + (event?.state == "waiting" ? 120 : 20), "stage-idle"), (lastFrame + 600, "stage-deep")]
        return deadlines.compactMap { at, source in at.map { (at: $0, source: source) } }
            .filter { $0.at > now + 0.001 }.min { $0.at < $1.at } ?? (now + poll, "stage-window-check")
    }
    var pointerActive: Bool { event != nil && shown && !asleep && !paused && !held && !locked && !displaySleeping }
    mutating func hide(_ reason: String, immediate: Bool = false, at: Double? = nil) -> [StageEffect] {
        beginTrace("hide", now: at ?? lastFrame, extra: ["reason": reason, "immediate": immediate]); defer { endTrace() }
        if hiddenReason != reason { hideReasonCounts[reason, default: 0] += 1 }
        let was = shown; shown = false; draw = nil; parkedAt = nil; hiddenReason = reason
        return [.hide(reason, immediate || !was || reason != "hide" ? 0 : 0.12)]
    }
    func forbidden(_ world: StageWorld, pointer: Double? = nil) -> [CGRect] {
        guard let event = event else { return [] }
        var out = world.base.above + world.cards + activeTargets + (world.person.map { [$0] } ?? [])
        out += wideFrames(world)
        if event.area == nil { out.append(stagePointRect(event.at, 48)) }
        if let rect = aimRect { out.append(rect.insetBy(dx: -48, dy: -48)) }
        if let end = event.end { out.append(stagePointRect(end, 48)) }
        // A2's under-edge target rule is retained for both endpoints and the aim rectangle's whole width.
        let edge = world.base.window.minY
        for p in (event.area == nil ? [event.at] : []) + (event.end.map { [$0] } ?? []) where p.y >= edge && p.y <= edge + 56 {
            out.append(CGRect(x: p.x - 72, y: edge, width: 144, height: 56))
        }
        let w = world.base.window
        if !w.isEmpty {
            out += [CGRect(x: w.minX, y: w.minY, width: min(80, w.width), height: 32),
                CGRect(x: max(w.minX, w.maxX - 80), y: w.minY, width: min(80, w.width), height: 32)]
        }
        if let radius = pointer { out.append(stagePointRect(world.pointer, radius)) }
        return out
    }
    func wideFrames(_ world: StageWorld) -> [CGRect] {
        var windows = world.windows ?? [:]
        if let ev = event, !world.base.window.isEmpty { windows[StageWindowKey(pid: ev.pid, window: ev.window)] = world.base.window }
        return windows.filter { wideWindows.contains($0.key) }.map { $0.value.insetBy(dx: -48, dy: -48) }
    }
    func clear(_ box: CGRect, _ world: StageWorld, pointer: Double? = nil) -> Bool {
        stageRectValid(box) && world.usable.contains(box) && !exclusions.contains { $0.intersects(box.insetBy(dx: -1, dy: -1)) } &&
            (pointer.map { !stagePointRect(world.pointer, $0).intersects(box) } ?? true)
    }
    func blockedSpan(_ lo: CGFloat, _ hi: CGFloat, width: CGFloat, y: CGFloat, height: CGFloat) -> Bool {
        var intervals: [(CGFloat, CGFloat)] = []
        for box in exclusions where box.width > 0 && box.height > 0 && box.minY < y + height && box.maxY > y {
            let left = box.minX - width, right = box.maxX
            if left < lo && right > hi { return true }
            if right > lo && left < hi { intervals.append((left, right)) }
        }
        var reach = lo
        for (left, right) in intervals.sorted(by: { $0.0 < $1.0 }) {
            // This span shortcut is permissive; clear also enforces the final one-point gap.
            if left >= reach { return false }
            reach = max(reach, right)
            if reach > hi { return true }
        }
        return false
    }
    func ladder(_ world: StageWorld) -> [(String, Double)] {
        let stage = options.points ?? min(480, max(288, Double(world.usable.height) * 0.36))
        let active = options.attention && world.inputAge < 8 && world.person != world.base.window
        if options.size == "small" { return [("small", 92)] }
        if options.size == "medium" { return [("medium", 184), ("small", 92)] }
        if (artProvider == nil && !stageArt) || active || !world.stageAvailable { return [("medium", min(184, stage)), ("small", min(92, stage))] }
        var previous = Double.infinity
        return [("stage", stage), ("three-quarter", stage * 0.75), ("medium", 184.0), ("small", 92.0)].filter { entry in
            guard entry.1 < previous else { return false }; previous = entry.1; return true
        }
    }
    mutating func place(_ world: StageWorld, avoidingPointer: Bool = true, dodge: Bool = false) -> StageSeat? {
        // Resolve the seat using manifest geometry first. Only that seat may make a foreground cache request.
        let dodged = locate(world, avoidingPointer: avoidingPointer, dodge: dodge)
        guard var next = dodged ?? (dodge ? locate(world, avoidingPointer: false, dodge: false) : nil) else { return nil }
        if artProvider != nil {
            let art = selectArt(artState(for: next.kind))
            if art?.medium == true {
                // A cold strip renders its A2 fallback at medium or small, in the same seat family.
                guard let fallback = locate(world, avoidingPointer: dodged == nil ? false : avoidingPointer,
                    dodge: dodged == nil ? false : dodge, only: next.kind, art: art) else { return nil }
                next = fallback
            }
            next.art = art
        }
        return next
    }
    func locate(_ world: StageWorld, avoidingPointer: Bool, dodge: Bool, only: String? = nil, art: SpriteStagePose? = nil) -> StageSeat? {
        guard let ev = event, let frame = base.frame, stageRectValid(world.usable),
            world.base.window.isEmpty || stageRectValid(world.base.window) && world.base.window.width >= 48,
            !world.stopped, !world.base.fullScreen else { return nil }
        // No person window: attention is unknown, so count it as looking (FA1 rule 3; no edge-sit or front-sit).
        let win = world.base.window, looking = world.person == nil || world.person == win || world.pointerAway < 5 || stageDistance(world.pointer, win) <= 100
        let tx = Double(ev.at.x)
        // Try every seat at this size before shrinking the authored stage art.
        for (rung, h) in ladder(world) {
        for screenEdge in [false, true] {
            if world.base.window.isEmpty && !screenEdge { continue }
            let large = ["stage", "three-quarter"].contains(rung)
            var kinds = ["edge-lie", "edge-sit", "corner-hang", "side-climb", "desk-stand"]
            if world.person == win { kinds = ["edge-lie", "corner-hang"] }
            if options.frontSit && options.size == "stage" && large && !looking { kinds.append("front-sit") }
            if screenEdge { kinds = ["edge-hang", "floor-stand"] }
            if let only = only { kinds = kinds.filter { $0 == only } }
            for kind in kinds {
                let entry = frame.stage?[artState(for: kind)]
                let own = entry?.file != nil && art == nil
                if large && (art?.medium == true || artProvider != nil && !own) { continue }
                let cell = art?.cell ?? (own ? entry!.cell : frame.cell)
                let anchor = art?.anchor ?? (own ? entry!.anchor : frame.perch?.anchor ?? CGPoint(x: frame.cell.width / 2, y: frame.cell.height))
                let artScale = h / 184 * Double(frame.cell.height / cell.height)
                let artH = Double(cell.height) * artScale, artW = Double(cell.width) * artScale
                let lieW = large ? max(1.5 * h, artW) : artW
                if kind == "edge-sit" && looking { continue }
                if kind == "edge-lie" && large && win.width < 1.5 * h + 160 - 0.001 { continue }
                var candidates: [CGRect] = []
                let bh = artH, bw = kind == "edge-lie" ? lieW : artW
                if kind == "edge-lie" || kind == "edge-sit" || screenEdge {
                    let lo = screenEdge ? world.usable.minX : win.minX + (large ? 80 : 0)
                    let hi = screenEdge ? world.usable.maxX - bw : win.maxX - (large ? 80 : 0) - bw
                    guard lo <= hi else { continue }
                    let y = screenEdge ? (kind == "edge-hang" ? world.usable.minY + 1.01 : world.usable.maxY - bh - 1.01) : win.minY - Double(anchor.y) * artScale
                    // The union of blocked x intervals can reject a whole span before allocating candidates.
                    if blockedSpan(lo, hi, width: bw, y: y, height: bh) { continue }
                    var xs = [min(max(tx - bw / 2, lo), hi), lo, hi]
                    // Obstacle boundaries produce a finite candidate set, no pixel scan and no per-frame layout loop.
                    for r in exclusions + (avoidingPointer ? [stagePointRect(world.pointer, 40)] : []) { xs += [r.minX - bw - 1.01, r.maxX + 1.01] }
                    if kind == "edge-sit" { xs.sort() } // One-way seated art dangles its legs over the left end of a free span.
                    if let old = seat, screenEdge ? old.kind == kind : old.window == ev.window {
                        xs.insert(old.box.minX, at: 0)
                        if dodge { xs = [old.box.minX + 120, old.box.minX - 120] + xs }
                    }
                    candidates = xs.filter { $0 >= lo && $0 <= hi }.map { CGRect(x: $0, y: y, width: bw, height: bh) }
                } else if kind == "corner-hang" || kind == "side-climb" {
                    let y = kind == "corner-hang" ? win.minY : min(max(ev.at.y - bh / 2, win.minY), win.maxY - bh)
                    candidates = [CGRect(x: win.maxX + 1.01, y: y, width: bw, height: bh), CGRect(x: win.minX - bw - 1.01, y: y, width: bw, height: bh)]
                } else if kind == "desk-stand" {
                    candidates = [CGRect(x: win.maxX + 1.01, y: win.maxY - bh, width: bw, height: bh), CGRect(x: win.minX - bw - 1.01, y: win.maxY - bh, width: bw, height: bh)]
                } else {
                    candidates = [CGRect(x: win.minX + 80, y: win.minY + 80, width: bw, height: bh),
                        CGRect(x: win.maxX - 80 - bw, y: win.minY + 80, width: bw, height: bh),
                        CGRect(x: win.minX + 80, y: win.maxY - 40 - bh, width: bw, height: bh),
                        CGRect(x: win.maxX - 80 - bw, y: win.maxY - 40 - bh, width: bw, height: bh)]
                    candidates = candidates.filter { r in win.contains(r) && (recent + [ev.at]).allSatisfy { stageDistance($0, r) >= h * 0.5 } }
                    candidates.sort { a, b in (recent + [ev.at]).map { stageDistance($0, a) }.min()! > (recent + [ev.at]).map { stageDistance($0, b) }.min()! }
                }
                for box in candidates where clear(box, world, pointer: avoidingPointer ? 40 : nil) {
                    if dodge {
                        guard let old = seat, kind == old.kind, h == old.height, abs(box.minY - old.box.minY) < 0.001,
                            abs(abs(box.minX - old.box.minX) - 120) < 0.1 else { continue }
                    }
                    return StageSeat(kind: kind, box: box, height: h, rung: rung, world: world, pid: ev.pid, window: ev.window, art: art)
                }
            }
        }
        }
        return nil
    }
    mutating func completeTurn(state: String, ok: Bool, now: Double? = nil, terminal: PerchEvent? = nil) {
        beginTrace("complete", now: now ?? lastFrame, world: nil, reduced: false, extra: ["state": state, "ok": ok]); defer { endTrace() }
        guard state == "handback" || state == "done" && !ok else { return }
        // Release protection at the terminal, then keep an already safe panel still for one poll.
        // WindowServer and Accessibility can observe its new frame before an external observer
        // has consumed the released protection snapshot. No action or input waits for this seat.
        if !terminalSeen { terminalSeatUntil = shown && seat != nil && !wideWindows.isEmpty ? (now ?? lastFrame) + 0.2 : nil }
        if !terminalSeen { endedWideEpoch = max(endedWideEpoch + 1, wideEpoch) }
        terminalSeen = true
        wideNames = []
        turnTargets = []; windowBook = StageWindowBook(); recent = []; targetCapacity = false; wideWindows = []; wideApps = []; compactedWindows = []; wideRecords = [:]; wideObservedFrames = [:]; pendingDrops = []; unmappedWindows = []; unmappableDrags = []; admissionWatermarks = [:]; geometryObservations = [:]; requiredReferences = [:]; noSeatWorld = nil; aimRect = nil
        carrying = false; carryUntil = 0; pointerBlocked = false; pointerClearSince = nil
        if let old = terminal ?? event, terminal != nil || !(old.state == "handback" || old.state == "done" && !old.ok) {
            reaction = state == "done" && base.turnOk == true ? "turn-success" : state
            afterReaction = nil; reactionBegan = nil; reactionUntil = nil; phase = nil; phaseUntil = nil
            event = PerchEvent(state: state, pid: old.pid, window: old.window, at: old.at, ok: false, drop: nil, end: nil, windowRect: nil)
            if let now = now { lastFrame = now }
        }
    }
    mutating func protectDrop(_ drop: CGPoint, world: StageWorld?) {
        guard let world = world, let windows = world.windows, !world.orderedWindows.isEmpty else { return }
        if let destination = world.orderedWindows.first(where: { windows[$0]?.contains(drop) == true }) {
            invalidateGeometry(destination); unmappableDrags.insert(destination)
            if let frame = windows[destination] {
                retainWide(destination, box: frame.insetBy(dx: -48, dy: -48))
                wideObservedFrames[destination] = frame
            }
        }
    }
    mutating func admitTargets(_ ev: PerchEvent, seq: Int, rect: CGRect?, world: StageWorld?, turnEnd: Bool) {
        guard !targetCapacity else { return }
        if let world = world { bindWindows(world, acting: StageWindowKey(pid: ev.pid, window: ev.window)) }
        if let area = ev.area, !turnEnd {
            if area == "app" {
                if wideApps.count < 128 || wideApps.contains(ev.pid) { wideApps.insert(ev.pid) }
                else { targetCapacity = true; return }
            }
            var keys = Set(windowBook.current.keys.filter { area == "app" && $0.pid == ev.pid })
            if ev.window > 0 { keys.insert(StageWindowKey(pid: ev.pid, window: ev.window)) }
            for key in keys {
                invalidateGeometry(key)
                if let bounds = windowBook.current[key]?.bounds { retainWide(key, box: bounds.insetBy(dx: -48, dy: -48)) }
            }
            return
        }
        var targets = [stagePointRect(ev.at, 48)]
        if let rect = rect { targets.append(rect.insetBy(dx: -48, dy: -48)) }
        if let end = ev.end { targets.append(stagePointRect(end, 48)) }
        if let edge = windowBook.current[StageWindowKey(pid: ev.pid, window: ev.window)]?.bounds.minY {
            for p in [ev.at] + (ev.end.map { [$0] } ?? []) where p.y >= edge && p.y <= edge + 56 {
                targets.append(CGRect(x: p.x - 72, y: edge, width: 144, height: 56))
            }
        }
        let key = StageWindowKey(pid: ev.pid, window: ev.window)
        if !turnEnd {
            if admissionWatermarks.count < 128 || admissionWatermarks[key] != nil { admissionWatermarks[key] = max(admissionWatermarks[key, default: -1], seq) }
            else { windowBook.overflow = true; targetCapacity = true; return }
        }
        if ev.state == "drag" {
            invalidateGeometry(key); unmappableDrags.insert(key)
            // PerchEvent.end is the grab point; its ring point (at) is the drop.
            if let world = world, world.windows != nil, !world.orderedWindows.isEmpty {
                protectDrop(ev.at, world: world)
            } else if pendingDrops.count < 128 {
                pendingDrops.append(ev.at)
            } else { targetCapacity = true }

        }
        if ev.state == "scroll" && !requiredReferences[key, default: []].contains(where: { $0.seq == seq }) {
            if turnTargets.contains(where: { $0.key == key }) || wideWindows.contains(key) { invalidateGeometry(key) }
            windowBook.contentChanged(key)
        }
        if !turnEnd, !compactedWindows.contains(key), !requiredReferences[key, default: []].contains(where: { $0.seq == seq }) {
            if requiredReferences.values.reduce(0, { $0 + $1.count }) >= 512 { collapseBusiest() }
            if !compactedWindows.contains(key) { requiredReferences[key, default: []].append(StageContributor(seq: seq, state: ev.state, content: windowBook.current[key]?.content ?? -1)) }
        }
        if !turnEnd, let epoch = windowBook.current[key], ev.windowRect == nil || stageSameTargetBounds(ev.windowRect!, epoch.bounds) {
            for target in targets { remember(target, key: key, epoch: epoch, contributor: StageContributor(seq: seq, state: ev.state, content: epoch.content)) }
        } else if !turnEnd {
            invalidateGeometry(key)
            if let measured = ev.windowRect, let observed = windowBook.current[key]?.bounds, !stageSameTargetBounds(measured, observed) {
                widenStale(key, measured: measured, observed: observed)
            }
            for target in targets {
                if let epoch = windowBook.current[key] { remember(target, key: key, epoch: epoch, contributor: StageContributor(seq: seq, state: ev.state, content: epoch.content)) }
                else { retainWide(key, box: target) }
            }
        }
    }
    mutating func admitPaused(_ ev: PerchEvent, seq: Int, rect: CGRect?, now: Double, world: StageWorld?) -> [StageEffect] {
        beginTrace("admission", now: now, world: world, extra: ["event": ev.traceJSON, "seq": seq, "rect": rect.map(stageTraceRect) as Any? ?? NSNull()]); defer { endTrace() }
        if event == nil { event = ev }
        terminalSeen = false; terminalSeatUntil = nil
        admitTargets(ev, seq: seq, rect: rect, world: world, turnEnd: false)
        noSeatWorld = nil
        return hide("paused-admission", immediate: true)
    }
    mutating func receive(_ ev: PerchEvent, seq: Int, rect: CGRect?, now: Double, world: StageWorld?, reduced: Bool, producer: StageProducerIdentity? = nil, protectsTarget: Bool = true) -> [StageEffect] {
        beginTrace("receive", now: now, world: world, reduced: reduced, extra: ["event": ev.traceJSON, "seq": seq, "rect": rect.map(stageTraceRect) as Any? ?? NSNull()]); defer { endTrace() }
        let terminal = ev.state == "handback" || ev.state == "done" && !ev.ok
        // Producer terminals complete at receipt, before ownership clears. Ring delivery cannot release again.
        if terminal && (producer != nil || producerOwner != nil) { return hide("producer-stale-terminal", immediate: true) }
        completeTurn(state: ev.state, ok: ev.ok, now: now)
        var ev = ev
        let turnEnd = ev.state == "handback" || ev.state == "done" && !ev.ok
        if !turnEnd { terminalSeen = false; terminalSeatUntil = nil }
        if turnEnd { ev.windowRect = nil }
        if protectsTarget && (producerOwner == nil || handKinds.contains(ev.state) || ev.state == "aim") {
            admitTargets(ev, seq: seq, rect: rect, world: world, turnEnd: turnEnd)
        }
        noSeatWorld = nil
        if paused && event != nil { return observe(now, world: world, reduced: reduced) }
        if let old = seat, old.window != ev.window || old.pid != ev.pid { moving = nil; stableAt = nil }
        woke = asleep
        event = ev; self.seq = seq; aimRect = rect; lastFrame = now; asleep = false
        let semantic = ev.state == "done" && ev.ok ? "perch" : ev.state == "done" && base.turnOk == true ? "turn-success" : ev.state
        // A routine call completion or screen read must not truncate the authored response to that call.
        let preserveReaction = (oneShot && (reactionUntil == nil || now < reactionUntil!) || phase != nil) &&
            (ev.state == "thinking" || ev.state == "done" && ev.ok)
        if preserveReaction {
            afterReaction = semantic
        } else {
            reaction = semantic; afterReaction = nil; reactionBegan = nil; reactionUntil = nil; phase = nil; phaseUntil = nil
        }
        if ev.state == "done" { base.turnOk = ev.ok ? true : nil }
        else if ev.state == "error" { base.turnOk = false }
        else if ev.state == "handback" { base.turnOk = nil }
        if handKinds.contains(ev.state) { recent.append(ev.at); if recent.count > 3 { recent.removeFirst() } }
        if ev.state == "paused" { paused = true }
        guard !held else { return hide("held", immediate: true) }
        return update(now, world: world, reduced: reduced, force: !preserveReaction)
    }
    mutating func setPaused(_ value: Bool, now: Double, world: StageWorld?, reduced: Bool) -> [StageEffect] {
        beginTrace("pause", now: now, world: world, reduced: reduced, extra: ["value": value]); defer { endTrace() }
        paused = value
        if let world = world { bindWindows(world) }
        if targetCapacity { return hide("target-capacity", immediate: true) }
        if !pendingDrops.isEmpty { return hide("drag-destination-pending", immediate: true) }
        if !value { return update(now, world: world, reduced: reduced, force: true) }
        guard var next = seat, let world = world, shown else { return observe(now, world: world, reduced: reduced) }
        if value, let previous = draw { next.box.origin = previous.pose.position(at: now - planBegan) }
        prepare(world)
        guard clear(next.box, world, pointer: badgeApproach ? nil : 40) else { return hide("paused-covered", immediate: true) }
        return install(next, now: now, reduced: reduced, faded: stageDistance(world.pointer, next.box) < 40, dodge: false)
    }
    mutating func pointerChanged(_ now: Double, enteredAt: Double, world: StageWorld?, reduced: Bool) -> [StageEffect] {
        beginTrace("pointer", now: now, world: world, reduced: reduced, extra: ["enteredAt": enteredAt]); defer { endTrace() }
        pointerEnteredAt = enteredAt
        return observe(now, world: world, reduced: reduced)
    }
    mutating func observe(_ now: Double, world: StageWorld?, reduced: Bool) -> [StageEffect] {
        beginTrace("observe", now: now, world: world, reduced: reduced, extra: [:]); defer { endTrace() }
        guard event != nil else { return [] }
        return update(now, world: world, reduced: reduced, force: false)
    }
    mutating func update(_ now: Double, world: StageWorld?, reduced: Bool, force: Bool) -> [StageEffect] {
        if producerCollectionOnly { return hide("producer-collection-only", immediate: true) }
        if now >= carryUntil { carrying = false }
        if let until = reactionUntil, now + 1e-9 >= until {
            reaction = afterReaction ?? "perch"; afterReaction = nil; reactionBegan = nil; reactionUntil = nil
        }
        if let until = phaseUntil, now + 1e-9 >= until { phase = nil; phaseUntil = nil }
        if locked || displaySleeping { return hide(locked ? "locked" : "sleeping", immediate: true) }
        if now - lastFrame >= 600 { event = nil; return hide("asleep") }
        let wantSleep = !paused && now - lastFrame >= (event?.state == "waiting" ? 120 : 20)
        let sleepChanged = asleep != wantSleep; asleep = wantSleep
        guard let world = world else { moving = nil; stableAt = nil; return hide("gone") }
        bindWindows(world)
        if targetCapacity { return hide("target-capacity", immediate: true) }
        if !pendingDrops.isEmpty { return hide("drag-destination-pending", immediate: true) }
        if let measured = event?.windowRect {
            let observed = world.base.window
            // Zero means compared without a stale-window decision. Nil means no comparison yet.
            if maxWindowBoundsDifferencePt == nil { maxWindowBoundsDifferencePt = 0 }
            if !stageSameTargetBounds(measured, observed) {
                let key = StageWindowKey(pid: event!.pid, window: event!.window)
                widenStale(key, measured: measured, observed: observed)
            }
        }
        locked = world.locked; displaySleeping = world.sleeping
        guard !world.stopped, !held else { return hide(world.locked ? "locked" : world.sleeping ? "sleeping" : world.call ? "call" : "held", immediate: true) }
        if world.base.fullScreen { return hide("full-screen") }
        // bindWindows retained the old obligations and widened the changed window.
        // Search outside both areas now instead of hiding for a settle timer.
        moving = nil; stableAt = nil
        if artProvider == nil, !force, !shown, let previous = noSeatWorld, samePlacementWorld(previous, world) { return [] }
        prepare(world)
        if let until = terminalSeatUntil {
            if now < until, shown, let previous = draw,
                clear(stagePanelBounds(previous.pose, previous.metrics), world, pointer: 40) { return [] }
            terminalSeatUntil = nil
        }
        if paused && shown, let old = seat {
            if ["stage", "three-quarter"].contains(old.rung) && !world.stageAvailable { return hide("stage-slot") }
            return clear(old.box, world) ? [] : hide("paused-covered", immediate: true)
        }
        let pointerNear = !badgeApproach && (seat.map { stageDistance(world.pointer, $0.box) < 40 } ?? false)
        let next = place(world, avoidingPointer: !badgeApproach, dodge: pointerNear)
        guard let next = next else { noSeatWorld = world; return hide("no-seat") }
        noSeatWorld = nil
        if !badgeApproach && stagePointRect(world.pointer, 40).intersects(next.box) {
            pointerBlocked = true; pointerClearSince = nil
            return hide("pointer-covered", immediate: true)
        }
        if pointerBlocked && !badgeApproach {
            if stagePointRect(world.pointer, 56).intersects(next.box) { pointerClearSince = nil; return hide("pointer-covered", immediate: true) }
            if pointerClearSince == nil { pointerClearSince = now }
            guard now - pointerClearSince! >= 0.3 else { return hide("pointer-covered", immediate: true) }
        }
        pointerBlocked = false; pointerClearSince = nil
        let faded = !badgeApproach && stageDistance(world.pointer, next.box) < 40
        let same = shown && seat?.box == next.box && seat?.kind == next.kind && seat?.height == next.height
        var unsafeMotion = false
        if let previous = draw, let last = previous.pose.positions.last, now - planBegan < last.0 {
            let elapsed = now - planBegan
            let remaining = [(elapsed, previous.pose.position(at: elapsed))] + previous.pose.positions.filter { $0.0 > elapsed }
            for (a, b) in zip(remaining, remaining.dropFirst()) {
                let swept = CGRect(origin: a.1, size: previous.seat.box.size).union(CGRect(origin: b.1, size: previous.seat.box.size))
                if !clear(swept, world, pointer: 100) || swept.intersects(world.base.window) { unsafeMotion = true; break }
            }
        }
        // A small correction follows the freshly placed seat without replaying its authored motion.
        // Exact epoch/certificate checks elsewhere still retain their provenance requirements.
        if !force, !sleepChanged, !unsafeMotion, shown, installedReaction == reaction, let old = seat, var previous = draw,
            old.world.base.window != world.base.window, stageSameWindowBounds(old.world.base.window, world.base.window),
            old.kind == next.kind, old.height == next.height, old.box.size == next.box.size,
            previous.art?.pending == next.art?.pending, previous.art?.source == next.art?.source, previous.art?.image === next.art?.image,
            previous.pose.reduced == reduced, previous.pose.opacity.last?.1 == (faded ? 0.35 : next.kind == "front-sit" ? 0.85 : 1) {
            let delta = CGPoint(x: next.box.minX - old.box.minX, y: next.box.minY - old.box.minY)
            let shifted = previous.pose.positions.map { ($0.0, CGPoint(x: $0.1.x + delta.x, y: $0.1.y + delta.y)) }
            let safe = zip(shifted, shifted.dropFirst()).allSatisfy { a, b in
                clear(CGRect(origin: a.1, size: next.box.size).union(CGRect(origin: b.1, size: next.box.size)), world, pointer: 100)
            } && shifted.allSatisfy { clear(CGRect(origin: $0.1, size: next.box.size), world, pointer: 40) }
            if abs(delta.x) <= 2, abs(delta.y) <= 2, safe {
                let difference = stageWindowEdgeDifference(old.world.base.window, world.base.window)
                silentReseats += 1; maxSilentReseatDifferencePt = max(maxSilentReseatDifferencePt, difference)
                var observation = PerchWindowObservation(pid: next.pid, window: next.window, expected: old.world.base.window, observed: world.base.window)
#if SLEIGHT_STAGE_BENCH
                observation.fixture = stageBenchLegacyWindowFrame?(next.pid, next.window)
#endif
                windowDecisions.append(observation.json.merging(["decision": "silent-reseat", "time": now]) { $1 })
                if windowDecisions.count > 128 { windowDecisions.removeFirst(windowDecisions.count - 128) }
                previous.pose.positions = shifted
                previous.pose.seat.x += delta.x; previous.pose.seat.edge += delta.y; previous.pose.seat.frame = world.base.window
                previous.seat = next; seat = next; draw = previous
                return [.reseat(delta)]
            }
        }
        if phase != nil, !force, !sleepChanged, !unsafeMotion, same, let previous = draw,
            samePlacementWorld(previous.seat.world, world), phaseUntil != nil { return [] }
        if same && !force && !sleepChanged && !unsafeMotion && phase == nil && installedReaction == reaction && draw?.art?.pending == next.art?.pending && draw?.art?.source == next.art?.source && draw?.art?.image === next.art?.image && draw?.pose.reduced == reduced && draw?.pose.opacity.last?.1 == (faded ? 0.35 : next.kind == "front-sit" ? 0.85 : 1) {
            if let until = parkedAt, now >= until { parkedAt = nil; return [.park] }; return []
        }
        return install(next, now: now, reduced: reduced, faded: faded, dodge: pointerNear, forcePop: unsafeMotion)
    }
    mutating func install(_ next: StageSeat, now: Double, reduced: Bool, faded: Bool, dodge: Bool, forcePop: Bool = false) -> [StageEffect] {
        guard let frame = base.frame, let ev = event, let table = frame.perch else { return hide("no-perch") }
        artPose = next.art
        let old = seat, previous = draw
        // Pose cells and geometry use the same cache selection. A cold or missing strip stays at medium.
        let cell = artPose?.cell ?? frame.cell
        let scale = next.height / 184 * Double(frame.cell.height / cell.height)
        var scaled = frame
        scaled = SpriteFrame(seq: frame.seq, id: frame.id, sheet: frame.sheet, extra: frame.extra, cell: cell, table: frame.table,
            perch: frame.perch, perchSheet: frame.perchSheet, lines: frame.lines, stage: frame.stage, stageOptions: frame.stageOptions)
        let entries = table.table.mapValues { e in SpriteEntry(sheet: e.sheet, row: e.row, columns: e.columns, ms: e.ms, loop: e.loop, flip: e.flip,
            hotspot: e.hotspot, size: e.size, scale: scale, then: e.then) }
        scaled.perch = PerchTable(anchor: CGPoint(x: cell.width / 2, y: cell.height), table: entries)
        base.frame = scaled
        defer { base.frame = frame }
        let metrics = perchMetrics(scaled)!
        let box = next.box, anchorX = box.midX
        base.seat = PerchSeat(pid: next.pid, window: next.window, x: anchorX, edge: box.maxY, peek: false, rise: Double(box.height),
            frame: next.world.base.window, display: next.world.base.display, top: Double(next.world.usable.minY))
        base.seat?.usable = next.world.usable
        let env = PerchEnvironment(world: { _, _ in next.world.base }, reduced: { reduced }, measure: { _ in .zero })
        guard var pose = base.draw(paused ? "paused" : asleep ? "sleep" : reaction, ok: ev.ok, at: ev.at, move: nil, from: nil, woke: woke, now: now, env: env) else { return hide("no-pose") }
        // Remove A2's reaction bumps: the placement is approved for this exact box. Motion below is checked separately.
        let origin = CGPoint(x: box.minX, y: box.minY)
        pose.positions = [(0, origin)]; pose.masked = [(0, false)]; pose.zs = false
        let opacity = faded ? 0.35 : next.kind == "front-sit" ? 0.85 : 1
        pose.opacity = [(0, opacity)]; pose.kind = "stay"
        if forcePop {
            pose.kind = "far"; pose.opacity = [(0, 0), (0.12, opacity)]
        } else if let old = old, shown, let previous = previous, old.box != box || old.kind != next.kind &&
            (["edge-hang", "floor-stand"].contains(old.kind) || ["edge-hang", "floor-stand"].contains(next.kind)) {
            // Interruption starts at the presentation position, never at the old destination.
            let from = previous.pose.position(at: now - planBegan)
            let d = hypot(box.minX - from.x, box.minY - from.y)
            var positions: [(Double, CGPoint)] = []
            let sizeChanged = old.height != next.height, displayChanged = old.world.base.display != next.world.base.display
            let screenEdge = ["edge-hang", "floor-stand"].contains(next.kind) || ["edge-hang", "floor-stand"].contains(old.kind)
            var far = reduced || sizeChanged || displayChanged || dodge || screenEdge
            if !far {
                let sameWindow = old.window == next.window && old.pid == next.pid
                let seatChange = sameWindow && old.kind != next.kind
                let run = sameWindow && !seatChange && d > 4 * next.height
                let hops = sameWindow && !seatChange && !run ? max(1, Int(ceil(d / (1.3 * next.height)))) : 1
                let span = seatChange ? (next.kind == "corner-hang" ? 0.26 : 0.4) : sameWindow ? (run ? min(0.6, d / 600) : 0.24 * Double(hops)) : min(0.6, 0.32 + 0.0005 * d)
                let lift = run ? 0 : sameWindow ? min(14, next.height * 0.1) : 60.0
                for i in 0...(32 * hops) {
                    let f = Double(i) / Double(32 * hops)
                    let local = i == 32 * hops ? 1 : (f * Double(hops)).truncatingRemainder(dividingBy: 1)
                    positions.append((span * f, CGPoint(x: from.x + (box.minX - from.x) * f, y: from.y + (box.minY - from.y) * f - 4 * lift * local * (1 - local))))
                }
                // A swept rectangle for EVERY linear segment protects every in-between point, not just sample instants.
                for (a, b) in zip(positions, positions.dropFirst()) {
                    let swept = CGRect(origin: a.1, size: box.size).union(CGRect(origin: b.1, size: box.size))
                    if !clear(swept, next.world, pointer: 100) || swept.intersects(next.world.base.window) { far = true; break }
                }
                pose.kind = sameWindow ? (seatChange ? (next.kind == "corner-hang" ? "swing" : "drop") : run ? "run" : "hop") : "leap"
            }
            if far {
                // Drop the old panel before moving its origin. A discrete jump at zero opacity never sweeps content.
                pose.kind = displayChanged ? "far" : sizeChanged || reduced ? "crossfade" : "far"
                let duration = sizeChanged || reduced ? 0.15 : dodge ? 0.2 : 0.12
                pose.opacity = [(0, 0), (duration, opacity)]; positions = [(0, origin)]
            }
            pose.positions = positions
        } else if !shown { pose.kind = "arrive"; pose.opacity = [(0, 0), (0.12, opacity)] }
        let motion = pose.positions.last?.0 ?? 0
        let transition = !reduced && !paused ? (woke ? "stage-startle" : motion > 0 ? (pose.kind == "run" ? "stage-run" : "stage-leap") : phase) : nil
        if let state = transition, let travel = selectArt(state) {
            if travel.medium && next.height > 184 {
                guard var fallback = locate(next.world, avoidingPointer: true, dodge: false, only: next.kind, art: travel) else { return hide("no-seat") }
                fallback.art = travel
                return install(fallback, now: now, reduced: reduced, faded: faded, dodge: false, forcePop: true)
            }
            // Fit the whole travel cell inside the approved swept box, including differing strip dimensions.
            artPose = travel; phase = state
            let duration = state == "stage-startle" ? travel.entry.ms.reduce(0, +) / 1000 : motion
            if phaseUntil == nil { phaseUntil = state == "stage-startle" && travel.pending ? nil : now + duration }
        }
        if let art = artPose {
            let e = art.entry
            let artScale = min(Double(box.width / art.cell.width), Double(box.height / art.cell.height))
            let entry = SpriteEntry(sheet: e.sheet, row: e.row, columns: e.columns, ms: e.ms, loop: e.loop, flip: e.flip,
                hotspot: e.hotspot, size: e.size, scale: artScale, then: e.then)
            var builder = PerchBuilder(table: [art.source: entry], reduced: reduced, plan: PerchPlan(kind: pose.kind, seat: pose.seat))
            let travelTime = phase == "stage-run" || phase == "stage-leap" ? max(0.001, (phaseUntil ?? now) - now) : nil
            let span = builder.play(art.source, at: 0, indices: oneShot || phase != nil ? Array(e.columns.indices) : nil, stretch: travelTime)
            pose.cells = builder.plan.cells; pose.states = [art.source]; pose.duration = span
            if phase == nil && oneShot && !paused && !art.pending {
                if reactionBegan == nil { reactionBegan = now; reactionUntil = now + (reduced ? e.ms.reduce(0, +) / 1000 : span) }
                let elapsed = max(0, now - (reactionBegan ?? now))
                if elapsed > 0, let current = builder.plan.cell(at: elapsed) {
                    pose.cells = [PerchCell(time: 0, state: current.state, entry: current.entry, column: current.column)] +
                        pose.cells.filter { $0.time > elapsed }.map { PerchCell(time: $0.time - elapsed, state: $0.state, entry: $0.entry, column: $0.column) }
                    pose.duration = max(0, span - elapsed)
                }
            }
        } else if oneShot && !paused && reactionUntil == nil { reactionBegan = now; reactionUntil = now + pose.duration }
        let motionTime = pose.positions.last?.0 ?? 0
        if motionTime > 0, !reduced, !paused, artPose == nil {
            let state = pose.kind == "run" ? (origin.x >= (pose.positions.first?.1.x ?? origin.x) ? "running-right" : "running-left") : ["leap", "drop"].contains(pose.kind) ? "jumping" : "perch-hop"
            if let entry = entries[state] {
                var builder = PerchBuilder(table: entries, reduced: false, plan: PerchPlan(kind: pose.kind, seat: pose.seat))
                builder.play(state, at: 0, indices: Array(entry.columns.indices), stretch: motionTime)
                pose.cells = builder.plan.cells + pose.cells.map { PerchCell(time: $0.time + motionTime, state: $0.state, entry: $0.entry, column: $0.column) }
                pose.states = [state] + pose.states; pose.duration += motionTime
            }
        }
        pose.duration = max(pose.duration, pose.positions.last?.0 ?? 0, pose.opacity.last?.0 ?? 0)
        // A static NSPanel encloses the entire animation, including empty space between its segments.
        // If that rectangle cannot be seated, present the destination cell without a swept panel.
        if !clear(stagePanelBounds(pose, metrics), next.world, pointer: 40) {
            pose.positions = [(0, origin)]; pose.kind = "far"
            pose.opacity = [(0, 0), (0.12, opacity)]
        }
        if paused { pose.cells = Array(pose.cells.prefix(1)); pose.duration = 0; pose.positions = [(0, origin)]; pose.opacity = [(0, opacity)] }
        let result = StageDraw(pose: pose, seat: next, metrics: metrics, seq: seq, fallback: (artPose?.medium ?? !stageArt) && options.size == "stage", dodgeMs: pointerEnteredAt.map { max(0, now - $0) * 1000 } ?? 0, decisionReason: dodge ? "pointer-near" : nil, art: artPose, seatLine: box.minY + (artPose?.anchor.y ?? table.anchor.y) * scale)
        pointerEnteredAt = nil; hiddenReason = nil
        seat = next; draw = result; installedReaction = reaction; shown = true; planBegan = now; parkedAt = now + pose.duration
        woke = false
        return [.draw(result)]
    }
}
// Metadata only. A front app without an on-screen window gives no person window (nothing to protect), and the
// character still seats; a missing display identity hides it instead of guessing. Cards include our own
// panels, which the legacy perch world deliberately omits from its foreign-window stack.
func stagePersonWindow(_ list: [[String: Any]], frontPID: Int32?, ownPID: Int32, standIn: StageWindowKey? = nil) -> CGRect? {
    guard let pid = standIn?.pid ?? frontPID, standIn != nil || pid != ownPID,
        let info = list.first(where: {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
            ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 &&
            (standIn == nil || ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == standIn?.window)
        }), let raw = info[kCGWindowBounds as String] as? NSDictionary,
        let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), stageRectValid(rect) else { return nil }
    return rect
}
func stageWindowlessAbove(_ list: [[String: Any]], own: Int32) -> [CGRect] {
    list.compactMap { item -> CGRect? in
        let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        let alpha = (item[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value != own,
            layer >= 0, layer < 1000, alpha > 0,
            let raw = item[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: raw as CFDictionary)
    }
}
// Both the host and the geometry dump apply this final call veto to queued draws.
func stageCallApply(_ effects: [StageEffect], runtime: inout StageRuntime, active: () -> Bool, at now: Double) -> [StageEffect] {
    if effects.contains(where: { switch $0 { case .draw, .reseat: return true; default: return false } }), active() {
        return runtime.hide("call", immediate: true, at: now)
    }
    return effects
}
func stageWorld(pid: Int32, window: UInt32, pointerAway: Double, locked: Bool, sleeping: Bool, call: Bool, snapshot: [[String: Any]]? = nil) -> StageWorld? {
    guard let list = snapshot ?? (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]),
        let primary = NSScreen.screens.first?.frame.maxY else { return nil }
    func topRect(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: primary - r.maxY, width: r.width, height: r.height) }
    let observedBase = perchWorld(pid: pid, window: window, snapshot: list)
    guard let screen = observedBase.flatMap({ base in NSScreen.screens.first(where: { topRect($0.frame) == base.display }) }) ?? NSScreen.screens.first else { return nil }
    let windowlessAbove = stageWindowlessAbove(list, own: getpid())
    let base = observedBase ?? PerchWorld(window: .zero, above: windowlessAbove, display: topRect(screen.frame), top: Double(topRect(screen.visibleFrame).minY), fullScreen: false)
    var standIn: StageWindowKey?
#if SLEIGHT_STAGE_BENCH
    standIn = stageBenchPersonWindow
#endif
    // No person window (a windowless app in front: Finder with no windows, a menu-bar app, an app on another Space)
    // leaves nothing to protect, so the character still seats. Returning no world here hid it as "gone" (2026-11-09).
    let person = stagePersonWindow(list, frontPID: NSWorkspace.shared.frontmostApplication?.processIdentifier,
        ownPID: getpid(), standIn: standIn)
    var pointer = CGPoint(x: NSEvent.mouseLocation.x, y: primary - NSEvent.mouseLocation.y)
#if SLEIGHT_STAGE_BENCH
    // Only the benchmark can replace the position input. Decision and effect dispatch remain the production path.
    if let input = stageBenchPointerPosition { pointer = input }
#endif
    let age = stageInputAge()
    guard age.isFinite, age >= 0 else { return nil }
    let cards = NSApp.windows.filter { $0.isVisible && $0.level.rawValue >= NSWindow.Level.modalPanel.rawValue }.map { topRect($0.frame) }
    let windows = stageWindows(list)
    let ordered = list.compactMap { info -> StageWindowKey? in
        guard (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
            let owner = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
            let id = (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value else { return nil }
        let key = StageWindowKey(pid: owner, window: id)
        return windows[key] == nil ? nil : key
    }
    return StageWorld(base: base, usable: topRect(screen.visibleFrame), person: person, pointer: pointer, inputAge: age,
        pointerAway: pointerAway, windows: windows, orderedWindows: ordered, cards: cards, locked: locked, sleeping: sleeping, call: call,
        displayID: (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber).map { String($0.uint32Value) })
}
// A running microphone is a call proxy, as for narration. Only a successful live reading hides the character.
// Pending and failed checks preserve the last successful reading, including shown before the first reading.
// The same executable reads metadata in one persistent pipe child. It never requests capture, activates an audio session,
// or inherits the consent pipe. A wedged Core Audio read cannot retain the host's worker or become a quiet sample.
func stageCallQuery() -> (quiet: Bool, state: String, reason: String) { stageCallWorker.query() }
let stageCallWorker = StageCallWorker()
// One outstanding query. 1 reads now, 3 subscribes, 4 waits, 5 invalidates listeners without an extra reply.
// A failed transaction discards the pipe and child, so a late quiet reply cannot answer a later request.
final class StageCallWorker {
    private let lock = NSLock(), controlLock = NSLock()
    private(set) var subscribed = false
    private(set) var pid: pid_t?
    private var input: Int32 = -1, output: Int32 = -1
    private(set) var spawns = 0
    deinit { stop() }
    @discardableResult func collect() -> Bool {
        guard let child = pid else { return true }
        var status: Int32 = 0
        let result = waitpid(child, &status, WNOHANG)
        if result == child || result < 0 && errno == ECHILD { spriteUntrack(child); pid = nil; return true }
        return false
    }
    func refreshSubscription() {
        controlLock.lock(); defer { controlLock.unlock() }
        guard input >= 0 else { return }
        var request: UInt8 = 5; _ = write(input, &request, 1)
    }
    func stop() {
        controlLock.lock()
        if input >= 0 { close(input); input = -1 }; if output >= 0 { close(output); output = -1 }
        subscribed = false; controlLock.unlock()
        guard let child = pid, !collect() else { return }
        kill(child, SIGKILL)
        let until = CACurrentMediaTime() + 0.05
        repeat { if collect() { return }; usleep(1_000) } while CACurrentMediaTime() < until
        // Retain ownership and block replacement until a later nonblocking reap proves exit.
    }
    private func start(_ executable: String, _ arguments: [String]) -> Bool {
        if pid != nil { guard collect() else { return false } }
        var toChild: [Int32] = [-1, -1], fromChild: [Int32] = [-1, -1]
        guard pipe(&toChild) == 0 else { return false }
        defer { for fd in toChild where fd >= 0 { close(fd) } }
        guard pipe(&fromChild) == 0 else { return false }
        defer { for fd in fromChild where fd >= 0 { close(fd) } }
        for fd in toChild + fromChild { guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0 else { return false } }
        guard fcntl(toChild[1], F_SETNOSIGPIPE, 1) == 0 else { return false }
        var actions: posix_spawn_file_actions_t? = nil, attributes: posix_spawnattr_t? = nil
        guard posix_spawn_file_actions_init(&actions) == 0 else { return false }
        defer { posix_spawn_file_actions_destroy(&actions) }
        guard posix_spawnattr_init(&attributes) == 0 else { return false }
        defer { posix_spawnattr_destroy(&attributes) }
        guard posix_spawn_file_actions_adddup2(&actions, toChild[0], 0) == 0,
            posix_spawn_file_actions_adddup2(&actions, fromChild[1], 1) == 0,
            posix_spawn_file_actions_addopen(&actions, 2, "/dev/null", O_WRONLY, 0) == 0 else { return false }
        var empty = sigset_t(), defaults = sigset_t(); sigemptyset(&empty); sigfillset(&defaults)
        guard posix_spawnattr_setsigmask(&attributes, &empty) == 0,
            posix_spawnattr_setsigdefault(&attributes, &defaults) == 0,
            posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) == 0 else { return false }
        let argv = ([executable] + arguments).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }
        var pid: pid_t = 0
        guard posix_spawn(&pid, executable, &actions, &attributes, argv, environ) == 0 else { return false }
        let tracked = spriteTrack(pid)
        self.pid = pid; spawns += 1
        guard tracked else { stop(); return false }
        controlLock.lock()
        input = toChild[1]; toChild[1] = -1; output = fromChild[0]; fromChild[0] = -1
        controlLock.unlock()
        return true
    }
    func query(executable: String? = Bundle.main.executablePath, arguments: [String] = ["--stage-call-worker"],
        deadline: Double? = 1, requestByte: UInt8 = 1) -> (quiet: Bool, state: String, reason: String) {
        lock.lock(); defer { lock.unlock() }
        let unavailable = (false, "unavailable", "microphone process metadata unavailable")
        let began = CACurrentMediaTime()
        if input < 0 {
            guard let executable = executable, start(executable, arguments) else {
                return pid == nil ? unavailable : (false, "unavailable", "microphone metadata child cleanup pending")
            }
        }
        var ready = pollfd(fd: output, events: Int16(POLLIN), revents: 0)
        // EOF or an unsolicited reply invalidates the transaction before writing a new request.
        guard poll(&ready, 1, 0) == 0 else { stop(); return unavailable }
        var request = requestByte
        guard write(input, &request, 1) == 1 else { stop(); return unavailable }
        while true {
            let left = deadline.map { $0 - (CACurrentMediaTime() - began) } ?? Double.infinity
            if left <= 0 {
                stop(); return (false, "timeout", "microphone metadata query timed out (1 s deadline)")
            }
            ready.revents = 0
            // A subscribed idle worker has no deadline and no polling timeout. Its own
            // alarm still bounds each actual Core Audio read; pipe EOF reports a dead source.
            let result = poll(&ready, 1, deadline == nil ? -1 : Int32(min(1000, ceil(left * 1000))))
            if result < 0 && errno == EINTR { continue }
            if result == 0 { continue }
            guard result > 0, ready.revents & Int16(POLLIN) != 0 else { stop(); return unavailable }
            var response: UInt8 = 255
            guard read(output, &response, 1) == 1 else { stop(); return unavailable }
            // A reply read after the deadline never becomes a completed quiet reading.
            guard deadline.map({ CACurrentMediaTime() - began <= $0 }) ?? true else {
                stop(); return (false, "timeout", "microphone metadata query timed out (1 s deadline)")
            }
            switch response {
            case 0: subscribed = requestByte != 1; return (true, "quiet", "quiet")
            case 1: subscribed = requestByte != 1; return (false, "input-active", "microphone input active")
            case 3: subscribed = false; return (true, "quiet", "quiet")
            case 4: subscribed = false; return (false, "input-active", "microphone input active")
            case 2: return unavailable
            default: stop(); return unavailable
            }
        }
    }
}
// Property listeners invalidate readings; they never count as a successful input reading.
// One coalesced byte wakes a transaction. A 30 s safety census repairs missed notifications. No audio IO or capture.
struct StageCallWatchAudio {
    var processes: () -> [AudioObjectID]?
    var add: (AudioObjectID, AudioObjectPropertySelector, DispatchQueue, @escaping AudioObjectPropertyListenerBlock) -> OSStatus
    var remove: (AudioObjectID, AudioObjectPropertySelector, DispatchQueue, @escaping AudioObjectPropertyListenerBlock) -> OSStatus
    static let system = StageCallWatchAudio(processes: NarrationAudio.system.processes, add: { object, selector, queue, block in
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectAddPropertyListenerBlock(object, &address, queue, block)
    }, remove: { object, selector, queue, block in
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        return AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)
    })
}
final class StageCallInputWatch {
    let audio: StageCallWatchAudio
    let queue = DispatchQueue(label: "com.sleight.microphone-metadata", qos: .utility)
    private let lock = NSLock()
    private var pipeEnds: [Int32] = [-1, -1], dirty = false, system = false, restart = false, resetRequired = false
    private var objects: Set<AudioObjectID> = []
    private lazy var listener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.invalidate() }
    private lazy var restartListener: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.invalidate(reset: true) }
    init(audio: StageCallWatchAudio = .system) { self.audio = audio }
    deinit { stop() }
    func invalidate(reset: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        resetRequired = resetRequired || reset
        guard pipeEnds[1] >= 0, !dirty else { return }
        var byte: UInt8 = 1
        if write(pipeEnds[1], &byte, 1) == 1 { dirty = true }
    }
    func stop() {
        if restart { _ = audio.remove(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyServiceRestarted, queue, restartListener); restart = false }
        if system { _ = audio.remove(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, queue, listener); system = false }
        for object in objects { _ = audio.remove(object, kAudioProcessPropertyIsRunningInput, queue, listener) }
        objects = []
        lock.lock(); defer { lock.unlock() }
        for fd in pipeEnds where fd >= 0 { close(fd) }; pipeEnds = [-1, -1]; dirty = false; resetRequired = false
    }
    func refresh() -> Bool {
        guard #available(macOS 14.2, *) else { return false }
        if pipeEnds[0] < 0 {
            guard pipe(&pipeEnds) == 0 else { return false }
            for fd in pipeEnds {
                guard fcntl(fd, F_SETFD, FD_CLOEXEC) == 0, fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else { stop(); return false }
            }
        }
        if !system {
            guard audio.add(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList, queue, listener) == noErr else { return false }
            system = true
        }
        if !restart {
            guard audio.add(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyServiceRestarted, queue, restartListener) == noErr else { return false }
            restart = true
        }
        // Install before sampling. An input or process-list change during a read stays queued for the next transaction.
        guard let list = audio.processes() else { return false }
        let current = Set(list)
        for object in objects.subtracting(current) {
            _ = audio.remove(object, kAudioProcessPropertyIsRunningInput, queue, listener); objects.remove(object)
        }
        for object in current.subtracting(objects) {
            guard audio.add(object, kAudioProcessPropertyIsRunningInput, queue, listener) == noErr else { return false }
            objects.insert(object)
        }
        return true
    }
    func clear() -> Bool {
        lock.lock(); defer { lock.unlock() }
        var byte: UInt8 = 0
        while read(pipeEnds[0], &byte, 1) == 1 {}
        dirty = false
        let reset = resetRequired; resetRequired = false; return reset
    }
    // 2: rebuild (safety deadline, service restart, sleep/wake), 1: change, 0: EOF, -1: failure.
    func waitForChange() -> Int {
        guard pipeEnds[0] >= 0 else { return 2 }
        let deadline = CACurrentMediaTime() + 30
        while true {
            var fds = [pollfd(fd: 0, events: Int16(POLLIN), revents: 0),
                pollfd(fd: pipeEnds[0], events: Int16(POLLIN), revents: 0)]
            let remaining = max(0, deadline - CACurrentMediaTime())
            let result = poll(&fds, 2, Int32(ceil(remaining * 1000)))
            if result < 0 && errno == EINTR { continue }
            if result == 0 { return 2 }
            guard result > 0 else { return -1 }
            if fds[0].revents != 0 {
                var byte: UInt8 = 0
                let count = read(0, &byte, 1)
                return count == 0 ? 0 : count == 1 && byte == 5 ? 2 : -1
            }
            if fds[1].revents & Int16(POLLIN) != 0 { return clear() ? 2 : 1 }
            if fds[1].revents != 0 { return -1 }
        }
    }
}
func stageCallQueryMain() -> Int32 {
    // Each Core Audio transaction expires even if the parent disappears during the read.
    alarm(2); defer { alarm(0) }
    guard #available(macOS 14.2, *), let processes = NarrationAudio.system.processes() else { return 2 }
    var active = false
    for process in processes {
        guard let flag = NarrationAudio.system.word(process, kAudioProcessPropertyIsRunningInput,
            kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain) else { return 2 }
        if flag != 0 { active = true }
    }
    return active ? 1 : 0
}
func stageCallWorkerMain() -> Int32 {
    // EOF on the private request pipe ends an idle child immediately after parent loss.
    let watch = StageCallInputWatch()
    defer { watch.stop() }
    while true {
        var request: UInt8 = 0
        let count = read(0, &request, 1)
        if count < 0 && errno == EINTR { continue }
        if count == 0 { return 0 }
        guard count == 1, [1, 3, 4, 5].contains(request) else { return 2 }
        if request == 5 { alarm(2); watch.stop(); alarm(0); continue }
        if request == 4 {
            let changed = watch.waitForChange()
            if changed == 0 { return 0 }
            guard changed == 1 || changed == 2 else { return 2 }
            if changed == 2 { alarm(2); watch.stop(); alarm(0) }
        }
        var ready = false
        if request != 1 {
            alarm(2)
            ready = watch.refresh()
            if !ready { watch.stop() }
            alarm(0)
        }
        var result = UInt8(stageCallQueryMain())
        // A listener failure cannot discard a successful census. Degrade to per-wake reads.
        if request != 1 && !ready && result < 2 { result += 3 }
        guard write(1, &result, 1) == 1 else { return 2 }
    }
}
final class StageCallMonitor {
    var pending = false, sampled = -Double.infinity, requested = -Double.infinity
    private var observing = false
    private let worker: StageCallWorker
    private let executable: String?
    private let arguments: [String]
    init(worker: StageCallWorker = stageCallWorker, executable: String? = Bundle.main.executablePath, arguments: [String] = ["--stage-call-worker"]) {
        self.worker = worker; self.executable = executable; self.arguments = arguments
    }
    func refreshSubscription() { worker.refreshSubscription() }
    private(set) var lastSuccessfulInput: Bool?, successfulSampled = -Double.infinity
    private var completionQuiet = false
    // Retain the diagnostics fixture's direct-reading setter. Production completions always go through complete().
    var quiet: Bool {
        get { completionQuiet }
        set { completionQuiet = newValue; lastSuccessfulInput = !newValue }
    }
    var reason = "microphone metadata not requested", reported: Set<String> = []
    var sampleState = "not-requested", retryAt = -Double.infinity, backoff = 0.5
    var changed: (() -> Void)?
    var queryElapsedMs: Double?, prefetchAddedMs = 0.0
    func isActive(_ now: Double) -> Bool {
        lastSuccessfulInput == true
    }
    func statusReason(_ now: Double) -> String {
        pending ? "microphone metadata pending" : reason
    }
    func snapshot(_ now: Double) -> [String: Any] {
        let state = pending ? "pending" : sampleState
        let since = pending ? requested : sampled
        return ["state": state, "sampleState": sampleState, "pending": pending,
            "ageMs": since.isFinite ? max(0, now - since) * 1000 as Any : NSNull(),
            "lastCompletionAgeMs": sampled.isFinite ? max(0, now - sampled) * 1000 as Any : NSNull(),
            "active": isActive(now), "reason": statusReason(now),
            "lastSuccessfulState": lastSuccessfulInput.map { $0 ? "input-active" : "quiet" } as Any? ?? NSNull(),
            "lastSuccessAgeMs": successfulSampled.isFinite ? max(0, now - successfulSampled) * 1000 as Any : NSNull(),
            "queryElapsedMs": queryElapsedMs as Any? ?? NSNull(), "prefetchAddedMs": prefetchAddedMs]
    }
    func complete(_ result: (quiet: Bool, state: String, reason: String), at completed: Double, elapsedMs: Double?) {
        let wasActive = isActive(completed)
        let oldState = sampleState
        pending = false
        completionQuiet = result.quiet && result.state == "quiet"
        // A failure neither clears a live reading nor invents one. No freshness expiry changes visibility.
        if result.state == "quiet" && result.quiet { lastSuccessfulInput = false; successfulSampled = completed }
        else if result.state == "input-active" && !result.quiet { lastSuccessfulInput = true; successfulSampled = completed }
        reason = result.reason; sampleState = result.state; sampled = completed; queryElapsedMs = elapsedMs
        if ["timeout", "unavailable"].contains(result.state) {
            retryAt = sampled + backoff; backoff = min(30, backoff * 2)
        } else { retryAt = sampled; backoff = 0.5 }
        if wasActive != isActive(completed) || oldState != sampleState { changed?() }
    }
    func prefetch(_ now: Double) {
        let began = CACurrentMediaTime()
        defer { prefetchAddedMs = (CACurrentMediaTime() - began) * 1000 }
        if !observing && !pending && now - requested >= 0.5 && now >= retryAt {
            pending = true; observing = true; requested = now
            let worker = self.worker, executable = self.executable, arguments = self.arguments
            DispatchQueue.global(qos: .utility).async { [weak self] in
                var first = true
                while self != nil {
                    let began = CACurrentMediaTime()
                    let result = worker.query(executable: executable, arguments: arguments, deadline: first ? 1 : nil, requestByte: first ? 3 : 4)
                    let completed = CACurrentMediaTime(), elapsed = (completed - began) * 1000, initial = first
                    let failed = !["quiet", "input-active"].contains(result.state)
                    let fallback = !worker.subscribed
                    if failed { worker.stop() }
                    DispatchQueue.main.async { [weak self] in
                        if failed || fallback { self?.observing = false }
                        self?.complete(result, at: completed, elapsedMs: initial ? elapsed : nil)
                    }
                    if failed || fallback { return }
                    first = false
                }
            }
        }
    }
    func active(_ now: Double) -> Bool {
        prefetch(now)
        let active = isActive(now)
        if active && reported.insert("input-active").inserted { spriteWarning("character hidden: microphone input active") }
        return active
    }
}
func stageVisibilityStatus(stagePath: Bool, stageShown: Bool, legacyShown: Bool, panelVisible: Bool,
    rung: String?, reason: String?) -> [String: Any] {
    let up = (stagePath ? stageShown : legacyShown) && panelVisible
    return ["shown": up, "size": up ? (stagePath ? rung as Any? ?? NSNull() : "small") : NSNull(),
        "rendererPath": stagePath ? "stage" : "legacy-perch", "hideReason": up ? NSNull() : reason as Any? ?? "not-shown"]
}
// END STAGE

// BEGIN HONEST MOODS AND EDGE CHIPS (ST8)
func honestFieldsValid(_ data: [String: Any]) -> Bool {
    if let value = data["detail"] { guard let s = value as? String, ["approval", "payment", "page", "handoff", "person"].contains(s) else { return false } }
    if let value = data["retry"] { guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false } }
    if let value = data["transfer"] { guard data["kind"] as? String == "key", let s = value as? String, ["take", "give"].contains(s) else { return false } }
    return true
}
// Each cue is a two-cell layer animation inside the approved box, with no timer or new window.
final class HonestMoodCells {
    var detail: String?, retry = false, carrying = false
    var take: (Int32, UInt32, Double)?, carryUntil = 0.0
    func receive(_ plan: RingPlan, now: Double) {
        detail = plan.detail; retry = plan.retry; carrying = now < carryUntil
        if let prior = take, now < prior.2 || now - prior.2 > 30 { take = nil }
        if plan.state == "key", plan.transfer == "take" { take = (plan.pid, plan.window, now) }
        if plan.state == "key", plan.transfer == "give", let prior = take {
            carrying = prior.0 != plan.pid || prior.1 != plan.window
            if carrying { carryUntil = now + 0.6 }; take = nil
        }
    }
    func install(in root: CALayer, box: CGRect, reduced: Bool) {
        guard let detail = detail, ["approval", "payment", "page"].contains(detail) || retry || carrying else {
            if retry || carrying { draw(in: root, box: box, kind: carrying ? "carry" : "retry", reduced: reduced) }; return
        }
        draw(in: root, box: box, kind: detail, reduced: reduced)
    }
    func draw(in root: CALayer, box: CGRect, kind: String, reduced: Bool) {
        guard box.width >= 24, box.height >= 24 else { return }
        let layer = CAShapeLayer(), path = CGMutablePath()
        layer.name = "honest-" + kind; layer.frame = CGRect(x: box.maxX - 22, y: box.minY + 8, width: 16, height: 16)
        layer.strokeColor = NSColor.white.cgColor; layer.fillColor = NSColor(calibratedRed: 1, green: 0.48, blue: 0.24, alpha: 1).cgColor
        layer.lineWidth = 1.5
        switch kind {
        case "approval":
            path.move(to: CGPoint(x: 8, y: 1)); path.addQuadCurve(to: CGPoint(x: 13, y: 12), control: CGPoint(x: 18, y: 15))
            path.addQuadCurve(to: CGPoint(x: 3, y: 12), control: CGPoint(x: 8, y: 20)); path.addQuadCurve(to: CGPoint(x: 8, y: 1), control: CGPoint(x: -2, y: 15))
        case "payment", "carry":
            path.addRect(CGRect(x: 3, y: 2, width: 10, height: 12))
            path.move(to: CGPoint(x: 5, y: 6)); path.addLine(to: CGPoint(x: 11, y: 6))
            path.move(to: CGPoint(x: 5, y: 10)); path.addLine(to: CGPoint(x: 11, y: 10))
        case "page": path.addRoundedRect(in: CGRect(x: 2, y: 10, width: 12, height: 4), cornerWidth: 2, cornerHeight: 2)
        default:
            path.addArc(center: CGPoint(x: 8, y: 8), radius: 5, startAngle: 0, endAngle: .pi * 1.5, clockwise: false)
        }
        layer.path = path; root.addSublayer(layer)
        if !reduced {
            let cells = CAKeyframeAnimation(keyPath: "transform.translation.y")
            cells.values = [0, -2, 0]; cells.keyTimes = [0, 0.5, 1]; cells.calculationMode = .discrete
            cells.duration = kind == "page" ? 0.6 : 0.4; cells.repeatCount = kind == "page" ? 4 : 1
            layer.add(cells, forKey: "mood-cells")
        }
        if ["retry", "carry"].contains(kind) {
            let fade = CABasicAnimation(keyPath: "opacity"); fade.fromValue = 1; fade.toValue = 0; fade.beginTime = CACurrentMediaTime() + 0.6
            fade.duration = 0.12; fade.fillMode = .forwards; fade.isRemovedOnCompletion = false; layer.add(fade, forKey: "one-shot")
        }
    }
}
struct EdgeChipMessage {
    var op: String, pid: Int32 = 0, window: UInt32 = 0, count = 0, first = 0, time = 0.0, run: String? = nil
    static func parse(_ data: [String: Any]) -> EdgeChipMessage? {
        guard let op = data["op"] as? String else { return nil }
        let base: Set<String> = ["hand", "nonce", "op"]
        if ["clear", "end"].contains(op) { return Set(data.keys) == base ? EdgeChipMessage(op: op) : nil }
        func integer(_ key: String, _ max: Double) -> Double? {
            guard let n = data[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
                n.doubleValue >= 1, n.doubleValue <= max, n.doubleValue.rounded() == n.doubleValue else { return nil }; return n.doubleValue
        }
        guard op == "put", Set(data.keys) == base.union(["pid", "windowId", "count", "first", "time", "run"]),
            let pid = integer("pid", 2147483647), let window = integer("windowId", 4294967295), let count = integer("count", 999),
            let first = integer("first", 9007199254740991), let time = integer("time", 8640000000000000),
            data["run"] is NSNull || (data["run"] as? String)?.range(of: "^\\d{4}-\\d{2}-\\d{2}-[a-f0-9]{32}$", options: .regularExpression) != nil else { return nil }
        return EdgeChipMessage(op: op, pid: Int32(pid), window: UInt32(window), count: Int(count), first: Int(first), time: time, run: data["run"] as? String)
    }
}
// Top-left coordinates. The entire chip is above content and between the 80 pt control clamps.
func edgeChipRect(window: CGRect, usable: CGRect, excluding: [CGRect]) -> CGRect? {
    let box = CGRect(x: window.maxX - 80 - 48, y: window.minY - 24, width: 48, height: 22)
    guard stageRectValid(window), stageRectValid(usable), window.width >= 208, usable.contains(box),
        box.minX >= window.minX + 80, box.maxX <= window.maxX - 80, box.maxY <= window.minY,
        !excluding.contains(where: { $0.intersects(box) }) else { return nil }
    return box
}
final class EdgeChipView: NSView {
    var click: (() -> Void)?, clickable = false
    override func resetCursorRects() { if clickable { addCursorRect(bounds, cursor: .pointingHand) } }
    override func mouseUp(with event: NSEvent) {
        guard clickable, personActivation(event, windowMatches: event.window === window) else { return }; click?()
    }
    override func accessibilityPerformPress() -> Bool { false }
    override func accessibilityPerformAction(_ action: NSAccessibility.Action) {}
}
final class EdgeChipHost {
    weak var host: HandHost?
    var painted: [String: String] = [:]
    var rows: [String: EdgeChipMessage] = [:], panels: [String: HandPanel] = [:], expires: Double?, wake: DispatchWorkItem?, aim: CGRect?
    init(host: HandHost) { self.host = host }
    func hide() { panels.values.forEach { $0.orderOut(nil) }; wake?.cancel(); wake = nil }
    func receive(_ message: EdgeChipMessage) {
        if message.op == "clear" { hide(); rows.removeAll(); panels.removeAll(); painted.removeAll(); expires = nil; return }
        if message.op == "end" { expires = CACurrentMediaTime() + 600 }
        if message.op == "put" {
            let key = "\(message.pid):\(message.window)"
            guard rows[key] != nil || rows.count < 32 else { return }; rows[key] = message
        }
        refresh()
    }
    func refresh() {
        wake?.cancel(); wake = nil
        guard !rows.isEmpty, let host = host else { return }
        if let end = expires, CACurrentMediaTime() >= end { receive(EdgeChipMessage(op: "clear")); return }
        // Hidden rows still need to expire and recover from a timed-out capture hold or missing metadata.
        defer {
            let item = DispatchWorkItem { [weak self] in self?.refresh() }; wake = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: item)
        }
        guard host.cursorStyle == "sprite", !host.captureHeld, !host.perch.stageLocked, !host.perch.stageSleeping else { hide(); return }
        guard let snapshot = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { hide(); return }
        for (key, row) in rows {
            guard let world = stageWorld(pid: row.pid, window: row.window, pointerAway: 0, locked: false, sleeping: false, call: false, snapshot: snapshot), !world.base.fullScreen,
                let box = edgeChipRect(window: world.base.window, usable: world.usable,
                    excluding: world.base.above + world.cards + [world.person, aim, host.perch.frame.isNull ? nil : host.perch.frame].compactMap { $0 }) else { panels[key]?.orderOut(nil); continue }
            let panel = panels[key] ?? HandPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panels[key] = panel
            panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = false; panel.level = .floating
            panel.sharingType = .none; panel.ignoresMouseEvents = row.run == nil; panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.fullScreenAuxiliary]
            if panel.frame != appKitRect(box) { panel.setFrame(appKitRect(box), display: false) }
            let signature = "\(row.count):\(row.first):\(row.run ?? "")"
            if painted[key] != signature {
            painted[key] = signature
            let view = EdgeChipView(frame: CGRect(origin: .zero, size: box.size)); view.wantsLayer = true
            view.layer?.backgroundColor = NSColor(calibratedRed: 0.08, green: 0.1, blue: 0.15, alpha: 1).cgColor
            view.layer?.cornerRadius = 11; view.layer?.borderWidth = 1; view.layer?.borderColor = NSColor.white.cgColor
            let text = CATextLayer(); text.frame = CGRect(x: 19, y: 4, width: 26, height: 14); text.string = "\(row.count)"
            text.fontSize = 10; text.foregroundColor = NSColor.white.cgColor; text.contentsScale = panel.screen?.backingScaleFactor ?? 2
            view.layer?.addSublayer(text)
            // A 16 pt crop of the loaded character's idle cell, never a window image.
            if let character = host.perch.loaded, let idle = character.frame.table["idle"], let image = character.images[idle.sheet] {
                let face = CALayer(); face.frame = CGRect(x: 2, y: 3, width: 16, height: 16); face.contents = image
                face.contentsRect = PerchPlan.rect(idle, idle.columns[0], cell: character.frame.cell); view.layer?.addSublayer(face)
            }
            let formatter = DateFormatter(); formatter.dateFormat = "HH:mm"
            view.toolTip = "sleight changed this window: \(row.count) actions, \(formatter.string(from: Date(timeIntervalSince1970: row.time / 1000)))"
            view.clickable = row.run != nil
            view.click = { [weak self] in
                guard let self = self, let run = row.run, let nonce = nonceBook.nonce("hand") else { return }
                narrationJSON(["hand": "replay", "nonce": nonce, "run": run, "first": row.first])
                self.rows.removeValue(forKey: key); self.panels.removeValue(forKey: key)?.orderOut(nil)
            }
            panel.contentView = view
            }
            if !panel.isVisible { panel.orderFrontRegardless() }
        }
    }
}
// Pure parser and mood-state probe. It creates no application, panel or layer.
func honestMoodDump() {
    let mood = HonestMoodCells()
    while let line = readLine() {
        guard let bytes = line.data(using: .utf8), var data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            let now = data.removeValue(forKey: "clock") as? Double, now.isFinite, let frame = handFrame(data) else { exit(65) }
        let event: RingEvent
        switch frame { case let .act(_, act): event = ringEvent(act); case let .aim(_, ev), let .status(_, ev): event = ev; default: exit(65) }
        var plan = RingPlan(state: event.state, at: event.at ?? .zero)
        plan.pid = event.pid; plan.window = event.windowId; plan.detail = event.detail; plan.retry = event.retry; plan.transfer = event.transfer
        mood.receive(plan, now: now)
        let result: [String: Any] = ["detail": mood.detail as Any? ?? NSNull(), "retry": mood.retry, "carrying": mood.carrying]
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result) + Data([10]))
    }
}
func edgeChipDump() {
    while let line = readLine() {
        guard let bytes = line.data(using: .utf8), let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
        func rect(_ raw: Any?) -> CGRect? {
            guard let v = raw as? [Double], v.count == 4 else { return nil }
            let r = CGRect(x: v[0], y: v[1], width: v[2], height: v[3]); return stageRectValid(r) ? r : nil
        }
        guard let window = rect(data["window"]), let usable = rect(data["usable"]), let raw = data["excluding"] as? [Any] else { exit(65) }
        let excluded = raw.compactMap(rect); guard excluded.count == raw.count else { exit(65) }
        let box = edgeChipRect(window: window, usable: usable, excluding: excluded)
        let result: [String: Any] = ["rect": box.map { [$0.minX, $0.minY, $0.width, $0.height] } as Any? ?? NSNull(), "capture": "none"]
        FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result) + Data([10]))
    }
}
// END HONEST MOODS AND EDGE CHIPS (ST8)

// BEGIN HAND HOST
// The ghost hand (ROADMAP 2.7): a glove that glides to where sleight acts in a background window, flourishes and fades. It only
// draws: the panel never activates, takes key, catches a click or shows in another process's capture unless the user chose
// visible, and it is released after the fade, so an idle host has no window and no scheduled work. Perch mode (BEGIN PERCH) is the
// exception: a perched character keeps a window-list check every 0.5 s (2 s asleep), capped at 10 minutes asleep, covered or paused.
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
// The installer reads its flags back through the same interface in a real panel and the headless probe.
protocol HandPanelSurface: AnyObject {
    var sharingType: NSWindow.SharingType { get set }
    var ignoresMouseEvents: Bool { get set }
}
extension NSPanel: HandPanelSurface {}
struct HandPanelPolicy {
    var sharing: NSWindow.SharingType, ignoresMouseEvents = true
    init(sharing: NSWindow.SharingType, ignoresMouseEvents: Bool = true) { self.sharing = sharing; self.ignoresMouseEvents = ignoresMouseEvents }
    init(_ panel: HandPanelSurface) { sharing = panel.sharingType; ignoresMouseEvents = panel.ignoresMouseEvents }
    // Stage panels follow the user's hand capture setting like every other hand panel: hidden (the default) keeps them
    // out of screen captures, visible lets recordings show them. Same mapping as handCaptureModes.
    static func stageSharing(_ capture: String) -> NSWindow.SharingType { capture == "visible" ? .readOnly : .none }
    static func stage(capture: String = "hidden") -> HandPanelPolicy { HandPanelPolicy(sharing: stageSharing(capture)) }
    var captureName: String { sharing == .none ? "none" : sharing == .readOnly ? "readOnly" : "other" }
    var hitAreas: Int { ignoresMouseEvents ? 0 : 1 }
    var stageSafe: Bool { stageSafe(for: "hidden") }
    func stageSafe(for capture: String) -> Bool { sharing == HandPanelPolicy.stageSharing(capture) && ignoresMouseEvents }
    func apply(_ panel: HandPanelSurface) {
        if panel.sharingType != sharing { panel.sharingType = sharing }
        if panel.ignoresMouseEvents != ignoresMouseEvents { panel.ignoresMouseEvents = ignoresMouseEvents }
    }
}
final class StagePanelProbe: HandPanelSurface {
    var sharingType: NSWindow.SharingType = .readOnly, ignoresMouseEvents = false
}
func stagePanelSnapshot(_ panel: HandPanelSurface = StagePanelProbe(), capture: String = "hidden") -> HandPanelPolicy {
    HandPanelPolicy.stage(capture: capture).apply(panel)
    return HandPanelPolicy(panel)
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

// BEGIN CURSOR PAUSE PANEL
// Only the badge takes input, independent of the character's size or opaque body pixels.
func cursorBadgeRect(_ body: CGRect) -> CGRect {
    CGRect(x: body.maxX - 16, y: body.minY, width: 16, height: 16)
}
func cursorBadgeHit(_ point: CGPoint, _ body: CGRect) -> Bool { cursorBadgeRect(body).contains(point) }
func cursorDragArtAllowed(_ box: CGRect, excluding: [CGRect]) -> Bool { !excluding.contains { $0.intersects(box) } }

// A drag never touches the consent channel. Both ends require hardware input on the original badge window.
final class CursorBadgeDrag {
    let control: CursorPauseControl
    private(set) var active = false
    private var before = false, released = false, sent = false
    private var drop: [String: Any]?
    private var timeoutToken: UUID?, cancelTimeout: (() -> Void)?
    var finished: () -> Void = {}
    var epoch: () -> Double = { floor(Date().timeIntervalSince1970 * 1000) }
    var schedule: (Double, @escaping () -> Void) -> (() -> Void) = { delay, task in
        let work = DispatchWorkItem(block: task)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        return { work.cancel() }
    }
    init(_ control: CursorPauseControl) { self.control = control }
    @discardableResult func begin(_ event: NSEvent?, windowMatches: Bool) -> Bool {
        guard !active, control.pending == nil, event?.type == .leftMouseDown,
            personActivation(event, windowMatches: windowMatches, keyboard: false, now: control.now(), consent: true),
            event?.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) == 0 else { return false }
        active = true; before = control.paused; released = false; sent = false; drop = nil
        if !before, !control.request(true) { cancel(); return false }
        let token = UUID(); timeoutToken = token
        cancelTimeout = schedule(30) { [weak self] in
            guard let self = self, self.timeoutToken == token else { return }
            self.cancel()
        }
        return true
    }
    @discardableResult func end(_ event: NSEvent?, windowMatches: Bool, target: [String: Any]?) -> Bool {
        guard active, event?.type == .leftMouseUp,
            personActivation(event, windowMatches: windowMatches, keyboard: false, now: control.now()) else { return false }
        released = true
        if let target = target, let nonce = control.nonce() {
            drop = target.merging(["hand": "hint", "nonce": nonce, "ts": epoch()]) { $1 }
        }
        settle(); return true
    }
    func settle() {
        guard active else { return }
        guard !control.failed else { cancel(); return }
        guard released, control.pending == nil else { return }
        if !sent {
            guard control.paused else { cancel(); return }
            sent = true
            if let drop = drop { _ = control.send(drop) }
            if !before { if !control.request(false) { cancel() }; return }
        }
        cancel()
    }
    // Losing capture, the badge or a handshake preserves the committed pause.
    func cancel() {
        timeoutToken = nil; cancelTimeout?(); cancelTimeout = nil
        guard active else { return }; active = false; drop = nil; finished()
    }
}
func cursorHintTarget(at: CGPoint, snapshot: [[String: Any]]) -> [String: Any]? {
    for row in snapshot {
        guard let raw = row[kCGWindowBounds as String] as? [String: Any],
            let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds.contains(at) else { continue }
        guard let pid = row[kCGWindowOwnerPID as String] as? Int, pid > 0, pid != Int(getpid()),
            let window = row[kCGWindowNumber as String] as? UInt32, window > 0,
            row[kCGWindowLayer as String] as? Int == 0 else { return nil }
        return ["pid": pid, "windowId": window, "at": [at.x, at.y]]
    }
    return nil
}
func cursorDragMotion(_ event: NSEvent, now: Double) -> Bool {
    guard event.type == .leftMouseDragged, event.timestamp.isFinite, now >= event.timestamp, now - event.timestamp < 5,
        let cg = event.cgEvent else { return false }
    return cg.getIntegerValueField(.eventSourceStateID) == Int64(CGEventSourceStateID.hidSystemState.rawValue) &&
        cg.getIntegerValueField(.eventSourceUnixProcessID) == 0 && cg.getIntegerValueField(.eventSourceUserData) == 0
}
// A separate hit rectangle, never the ring's large click-through panel. There is no timer while parked.
func cursorPauseRect(at: CGPoint, size: CGSize, clip: CGRect, drag: Bool) -> CGRect? {
    guard !drag, size.width > 0, size.height > 0, size.width <= clip.width, size.height <= clip.height else { return nil }
    let right = at.x + 18 + size.width <= clip.maxX, below = at.y + 18 + size.height <= clip.maxY
    let x = min(max(right ? at.x + 18 : at.x - 18 - size.width, clip.minX), clip.maxX - size.width)
    let y = min(max(below ? at.y + 18 : at.y - 18 - size.height, clip.minY), clip.maxY - size.height)
    let box = CGRect(x: x, y: y, width: size.width, height: size.height)
    // Include the boundary in the exclusion, even though CGRect.contains excludes the max edges.
    guard !(at.x >= box.minX && at.x <= box.maxX && at.y >= box.minY && at.y <= box.maxY) else { return nil }
    return box
}
struct CursorPausePlacement {
    let rect: CGRect?, sprite: Bool, after: Double
    var json: [String: Any] { ["rect": rect.map { [$0.minX, $0.minY, $0.width, $0.height] } as Any? ?? NSNull(), "sprite": sprite, "after": after] }
    static func make(_ plan: RingPlan, clip: CGRect, sprite: Bool) -> CursorPausePlacement {
        var settled = 0.0
        for i in plan.positions.indices.dropFirst() where hypot(plan.positions[i].1.x - plan.positions[i - 1].1.x, plan.positions[i].1.y - plan.positions[i - 1].1.y) > 0.01 { settled = plan.positions[i].0 }
        if sprite, let art = plan.sprite, let pose = art.poses.last {
            for i in art.poses.indices.dropFirst() where art.poses[i].entry.scale != art.poses[i - 1].entry.scale { settled = max(settled, art.poses[i].time) }
            // Use the artwork's actual origin, including clipping, rather than moving its hit box into empty space.
            let cell = art.character.frame.cell
            let box = CGRect(origin: art.origin(plan.at, pose.entry), size: CGSize(width: cell.width * pose.entry.scale, height: cell.height * pose.entry.scale)).intersection(clip)
            return CursorPausePlacement(rect: plan.state == "drag" || box.isNull || box.isEmpty ? nil : box, sprite: true, after: max(settled, plan.total))
        }
        return CursorPausePlacement(rect: cursorPauseRect(at: plan.at, size: CGSize(width: 24, height: 24), clip: clip, drag: plan.state == "drag"), sprite: false, after: max(settled, plan.total))
    }
}
func cursorPauseCurrent(_ expected: CGRect, _ observed: CGRect?) -> Bool { observed == expected }
// A clear owns input-panel visibility through the action, including any waiting statuses from approval.
struct CursorPauseVisibility {
    private(set) var cleared = false
    mutating func clear() { cleared = true }
    mutating func status(_ state: String) { if ["done", "error"].contains(state) { cleared = false } }
    func placement(_ plan: RingPlan, clip: CGRect, sprite: Bool) -> CursorPausePlacement {
        let hit = CursorPausePlacement.make(plan, clip: clip, sprite: sprite)
        return CursorPausePlacement(rect: cleared ? nil : hit.rect, sprite: hit.sprite, after: hit.after)
    }
}
// The final displayed cell, sampled in its decoded RGBA image. Transparent atlas pixels never become controls.
struct CursorPauseMask {
    let image: CGImage, cell: CGSize, row: Int, column: Int, scale: Double, flip: Bool, origin: CGPoint
    func contains(_ point: CGPoint) -> Bool {
        var x = Int(floor((point.x - origin.x) / scale)), y = Int(floor((point.y - origin.y) / scale))
        guard x >= 0, y >= 0, x < Int(cell.width), y < Int(cell.height) else { return false }
        if flip { x = Int(cell.width) - 1 - x }
        x += column * Int(cell.width); y += row * Int(cell.height)
        guard x < image.width, y < image.height, let data = image.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return false }
        return bytes[y * image.bytesPerRow + x * 4 + 3] == 255
    }
    static func make(_ plan: RingPlan) -> CursorPauseMask? {
        guard let art = plan.sprite, let pose = art.poses.last, let image = art.character.images[pose.entry.sheet] else { return nil }
        return CursorPauseMask(image: image, cell: art.character.frame.cell, row: pose.entry.row, column: pose.column,
            scale: pose.entry.scale, flip: pose.entry.flip, origin: art.origin(plan.at, pose.entry))
    }
}
final class CursorPausePanel: NSPanel {
    static let mask: NSWindow.StyleMask = [.borderless, .nonactivatingPanel]
    static let key = false, main = false, firstMouse = true
    override var canBecomeKey: Bool { Self.key }
    override var canBecomeMain: Bool { Self.main }
}
final class CursorPauseView: NSView {
    let control: CursorPauseControl
    let current: () -> Bool
    var sprite = false, pressed = false
    var down: NSEvent?
    var drag: CursorBadgeDrag?
    var dragBegan: () -> Void = {}, dragMoved: (CGPoint) -> Void = { _ in }
    var hitOpaque: (NSPoint) -> Bool = { _ in true }
    override func hitTest(_ point: NSPoint) -> NSView? { hitOpaque(point) ? super.hitTest(point) : nil }
    init(_ control: CursorPauseControl, current: @escaping () -> Bool) { self.control = control; self.current = current; super.init(frame: .zero); setAccessibilityElement(false) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { CursorPausePanel.firstMouse }
    override func shouldDelayWindowOrdering(for event: NSEvent) -> Bool { true }
    override func accessibilityPerformPress() -> Bool { false }
    override func mouseDown(with event: NSEvent) {
        guard current(), hitOpaque(convert(event.locationInWindow, from: nil)) else { pressed = false; window?.orderOut(nil); return }
        pressed = event.cgEvent.map { $0.type == .leftMouseDown && $0.getIntegerValueField(.eventSourceUnixProcessID) == 0 } ?? false
        down = pressed ? event : nil
    }
    func screenPoint(_ event: NSEvent) -> CGPoint {
        let point = window?.convertPoint(toScreen: event.locationInWindow) ?? NSEvent.mouseLocation
        return CGPoint(x: point.x, y: (NSScreen.screens.first?.frame.maxY ?? 0) - point.y)
    }
    override func mouseDragged(with event: NSEvent) {
        guard pressed, let down = down, let window = window, let drag = drag,
            cursorDragMotion(event, now: control.now()) else { return }
        if !drag.active {
            guard current(), hypot(event.locationInWindow.x - down.locationInWindow.x, event.locationInWindow.y - down.locationInWindow.y) >= 3,
                drag.begin(down, windowMatches: down.window === window) else { return }
            dragBegan()
        }
        dragMoved(screenPoint(event))
    }
    override func mouseUp(with event: NSEvent) {
        defer { pressed = false; down = nil }
        if let drag = drag, drag.active {
            let snapshot = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            if !drag.end(event, windowMatches: event.window === window && window != nil, target: cursorHintTarget(at: screenPoint(event), snapshot: snapshot)) { drag.cancel() }
            return
        }
        guard let window = window, current(), pressed, hitOpaque(convert(event.locationInWindow, from: nil)), bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        _ = control.click(event, windowMatches: event.window === window)
    }
    override func draw(_ dirtyRect: NSRect) {
        guard !sprite else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let transform = NSAffineTransform(); transform.scaleX(by: bounds.width / 24, yBy: bounds.height / 24); transform.concat()
        let bounds = CGRect(x: 0, y: 0, width: 24, height: 24)
        NSColor(calibratedWhite: 0.08, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8).fill()
        (control.failed ? NSColor.systemOrange : NSColor.white).setFill()
        if control.failed {
            NSRect(x: 11, y: 10, width: 3, height: 8).fill(); NSRect(x: 11, y: 6, width: 3, height: 2).fill()
        } else if control.paused {
            let path = NSBezierPath(); path.move(to: NSPoint(x: 9, y: 6)); path.line(to: NSPoint(x: 17, y: 12)); path.line(to: NSPoint(x: 9, y: 18)); path.close(); path.fill()
        } else {
            NSRect(x: 8, y: 6, width: 3, height: 12).fill(); NSRect(x: 14, y: 6, width: 3, height: 12).fill()
        }
    }
}
final class CursorPauseOverlay {
    var panel: CursorPausePanel?, pending: DispatchWorkItem?
    var badgeRect: CGRect?
    weak var owner: AnyObject?
    var generation = 0
    var globalMonitor: Any?, localMonitor: Any?
    func hide(owner: AnyObject?) {
        guard let owner = owner, self.owner === owner else { return }
        hide()
    }
    func hide() {
        (panel?.contentView as? CursorPauseView)?.drag?.cancel()
        if let monitor = globalMonitor { NSEvent.removeMonitor(monitor) }; globalMonitor = nil
        if let monitor = localMonitor { NSEvent.removeMonitor(monitor) }; localMonitor = nil
        generation += 1; pending?.cancel(); pending = nil; panel?.ignoresMouseEvents = true; panel?.orderOut(nil); panel?.close(); panel = nil; owner = nil; badgeRect = nil }
    func translate(_ delta: CGPoint, owner: AnyObject?) {
        guard let owner = owner, self.owner === owner else { return }
        badgeRect = badgeRect?.offsetBy(dx: delta.x, dy: delta.y)
        if let panel = panel { panel.setFrame(panel.frame.offsetBy(dx: delta.x, dy: -delta.y), display: false) }
    }
    func show(_ rect: CGRect?, sprite: Bool, after delay: Double, capture: String, control: CursorPauseControl, mask: CursorPauseMask? = nil,
        drag: CursorBadgeDrag? = nil, owner: AnyObject? = nil, began: @escaping () -> Void = {}, moved: @escaping (CGPoint) -> Void = { _ in }, current: @escaping () -> Bool) {
        hide()
        guard let rect = rect else { return }
        self.owner = owner
        badgeRect = sprite ? cursorBadgeRect(rect) : rect
        let expected = generation
        let show = { [weak self] in
            guard let self = self, self.generation == expected else { return }
            self.pending = nil
            guard current(), let badge = self.badgeRect else { return }
            let panel = CursorPausePanel(contentRect: appKitRect(badge), styleMask: CursorPausePanel.mask, backing: .buffered, defer: true)
            panel.level = .floating; panel.hasShadow = false; panel.isOpaque = false; panel.backgroundColor = .clear
            panel.ignoresMouseEvents = false; panel.hidesOnDeactivate = false; panel.isReleasedWhenClosed = false
            panel.animationBehavior = .none; panel.becomesKeyOnlyIfNeeded = true
            panel.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary, .stationary]
            panel.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none
            panel.setAccessibilityElement(false)
            let view = CursorPauseView(control, current: current)
            view.drag = drag; view.dragBegan = began; view.dragMoved = moved
            view.hitOpaque = { [weak view] point in view.map { sprite ? cursorBadgeHit(point, $0.bounds) : $0.bounds.contains(point) } ?? false }
            view.toolTip = control.paused ? "Resume sleight" : "Pause sleight"
            panel.contentView = view
            self.panel = panel
            panel.orderFrontRegardless()
        }
        if delay <= 0 { show() }
        else {
            let item = DispatchWorkItem(block: show); pending = item
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
        }
    }
}
// Validation and geometry only. This mode never creates NSApplication, NSPanel or CALayer, or posts input.
func cursorPauseDump() {
    let control = CursorPauseControl()
    var clock = 1000.0, emitted: [[String: Any]] = [], lastEvent: NSEvent?
    var scheduled: [() -> Void] = [], appliedToken: String?, appliedValue = false
    control.now = { clock }; control.nonce = { String(repeating: "a", count: 64) }
    control.send = { emitted.append($0); return true }; control.schedule = { _, task in scheduled.append(task) }
    func rect(_ raw: Any?) -> CGRect? {
        guard let values = raw as? [Double], values.count == 4, values.allSatisfy({ $0.isFinite && abs($0) <= 100000 }) else { return nil }
        return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
    }
    while let line = readLine() {
        guard line.utf8.count <= 8192, let bytes = line.data(using: .utf8),
            let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
        var output: [String: Any] = ["canBecomeKey": CursorPausePanel.key, "canBecomeMain": CursorPausePanel.main,
            "acceptsFirstMouse": CursorPausePanel.firstMouse, "nonactivating": CursorPausePanel.mask.contains(.nonactivatingPanel)]
        if let gate = data["stageAdmissionCheck"] as? String {
            let host = HandHost(), bounds = CGRect(x: 200, y: 500, width: 900, height: 350)
            let key = StageWindowKey(pid: 42, window: 7), target = CGPoint(x: 650, y: 700)
            let world = StageWorld(base: PerchWorld(window: bounds, above: [], display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30, fullScreen: false),
                usable: CGRect(x: 0, y: 30, width: 1800, height: 1140), person: CGRect(x: 1450, y: 700, width: 300, height: 300),
                pointer: CGPoint(x: 1750, y: 1150), inputAge: 20, pointerAway: 10, windows: [key: bounds])
            host.admissionWorld = { _ in world }
            host.cursorStyle = "sprite"; host.perch.enabled = true
            host.perch.stageEffects = { _ in }; host.ringEffects = { _ in }
            if let raw = data["character"] as? [String: Any], case let .character(_, frame)? = handFrame(raw) {
                host.perch.stage.load(frame); host.perch.stage.stageArt = true
                host.perch.loaded = SpriteCharacter(frame: frame, images: [:], stage: SpriteStageCache(frame: frame))
            }
            output["fixtureLoaded"] = host.perch.stage.base.frame != nil
            host.perch.stage.options.size = "stage"
            host.perch.stage.event = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 450, y: 700), ok: false, drop: nil, end: nil, windowRect: bounds)
            host.perch.stage.windowBook.observe([key: bounds])
            host.perch.stage.lastFrame = 1
            _ = host.perch.stage.observe(1, world: world, reduced: true)
            output["shownBeforeHold"] = host.perch.stage.shown
            if data["trace"] as? Bool == true { host.perch.stage.trace = StageTrace() }
            let hold = data["hold"] as? String ?? "pause"
            if hold == "pause" { host.ownPause.set(true); host.perch.stage.paused = true }
            else if hold == "capture" { host.captureHolds["fixture"] = Date().addingTimeInterval(30) }
            else if hold == "drag" {
                // Unposted fixture event only. The production drag gate owns the active state.
                let stamp = ProcessInfo.processInfo.systemUptime
                host.ownPause.now = { stamp }; host.ownPause.nonce = { String(repeating: "a", count: 64) }
                host.ownPause.send = { _ in true }; host.ownPause.schedule = { _, _ in }
                host.badgeDrag.schedule = { _, _ in {} }
                let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState)!, virtualKey: 0, keyDown: true)!
                cg.type = .leftMouseDown; cg.timestamp = UInt64(stamp * 1e9)
                cg.setIntegerValueField(.eventSourceUnixProcessID, value: 0); cg.setIntegerValueField(.eventSourceUserData, value: 0)
                guard host.badgeDrag.begin(NSEvent(cgEvent: cg), windowMatches: true) else { exit(65) }
            } else { exit(65) }
            output["heldAtAdmission"] = hold == "pause" ? host.pauseControl.paused : hold == "capture" ? host.captureHeld : host.badgeDrag.active
            host.pauseVisibility.clear()
            let pauseGeneration = host.pauseOverlay.generation
            var event = RingEvent(seq: 3, state: data["state"] as? String ?? "aim", pid: 42, windowId: 7, at: target, rect: CGRect(x: 630, y: 680, width: 40, height: 40), label: nil)
            let measured = data["unknownGeometry"] as? Bool == true ? bounds.offsetBy(dx: 10, dy: 0) : bounds
            event.windowRect = measured
            if gate == "act" {
                guard case let .act(_, act)? = handFrame(["hand": "act", "nonce": String(repeating: "a", count: 64), "seq": 3,
                    "kind": "click", "pid": 42, "windowId": 7, "at": [650, 700], "windowRect": [measured.minX, measured.minY, measured.width, measured.height], "path": [[650, 700]], "delayMs": 0, "beats": 1]) else { exit(65) }
                host.receiveAct(act)
            } else if gate == "ring" { host.ringFrame(event, delay: 0) }
            else if gate == "cursor" { host.receiveCursor(event) } else { exit(65) }
            if let trace = host.perch.stage.trace { output["trace"] = trace.json }
            output["admitted"] = host.perch.stage.turnTargets.contains { $0.box.contains(target) && $0.contributors.contains { $0.seq == 3 } }
            output["shown"] = host.perch.stage.shown
            host.badgeDrag.cancel(); host.captureHolds.removeAll(); host.ownPause.set(false)
            _ = host.perch.stage.setPaused(false, now: 1, world: world, reduced: true)
            output["cleared"] = host.pauseVisibility.cleared
            output["pauseOverlayHides"] = host.pauseOverlay.generation - pauseGeneration
            output["afterResume"] = host.perch.stage.turnTargets.contains { $0.box.contains(target) }
            output["shownAfterResume"] = host.perch.stage.shown
            output["targetUnmapped"] = host.perch.stage.targetUnmapped
            output["windows"] = host.panel == nil && host.perch.panel == nil && host.pauseOverlay.panel == nil ? 0 : 1
            output["layers"] = host.ringRoot == nil && host.hand == nil && host.glove == nil ? 0 : 1
        } else if data["turnCompletionCheck"] as? Bool == true {
            var targets: [Int] = [], measured: [Bool] = [], receipts: [[String: Any]] = [], windows = 0
            for directRing in [true, false] {
                let host = HandHost()
                let bounds = CGRect(x: 200, y: 500, width: 900, height: 350)
                let key = StageWindowKey(pid: 42, window: 7)
                host.perch.stage.event = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 650, y: 700), ok: false, drop: nil, end: nil, windowRect: bounds)
                host.perch.stage.remember(bounds, key: key, epoch: StageWindowEpoch(bounds: bounds, generation: 1))
                // The guards prevent all rendering. Each entry point must release independently.
                host.ownPause.set(true)
                let done = RingEvent(seq: 3, state: "done", pid: 42, windowId: 7, at: nil, rect: nil, label: nil)
                if directRing { host.ringFrame(done, delay: 0) } else { host.receiveCursor(done) }
                _ = host.perch.stage.hide("stale-window")
                host.perch.stage.maxWindowBoundsDifferencePt = 2.25
                receipts.append(host.perch.diagnostics.filter { ["hideReasonCounts", "maxWindowBoundsDifferencePt"].contains($0.key) })
                targets.append(host.perch.stage.turnTargets.count)
                measured.append(host.perch.stage.event?.windowRect != nil)
                windows += host.panel == nil && host.perch.panel == nil && host.pauseOverlay.panel == nil ? 0 : 1
            }
            output["turnTargets"] = targets; output["measuredBounds"] = measured; output["windows"] = windows; output["receipts"] = receipts
        } else if let frame = data["exitFrame"] as? [String: Any] {
            output["exitAccepted"] = handControlExit(frame, nonce: String(repeating: "a", count: 64))
        } else if data["badgeLifetimeCheck"] as? Bool == true {
            let overlay = CursorPauseOverlay(), owner = NSObject(), other = NSObject()
            overlay.show(CGRect(x: 0, y: 0, width: 96, height: 104), sprite: true, after: 10, capture: "hidden", control: control, owner: owner, current: { false })
            output["pendingBefore"] = overlay.pending != nil
            overlay.hide(owner: other); output["pendingAfterOtherOwner"] = overlay.pending != nil
            overlay.hide(owner: owner); output["pendingAfterOwner"] = overlay.pending != nil; output["windows"] = overlay.panel == nil ? 0 : 1
        } else if data["dragArtCheck"] as? Bool == true {
            let avoid = [CGRect(x: 0, y: 0, width: 200, height: 200), CGRect(x: 300, y: 0, width: 100, height: 100), CGRect(x: 0, y: 300, width: 200, height: 50)]
            output["allowed"] = [CGRect(x: 500, y: 500, width: 96, height: 104), CGRect(x: 190, y: 190, width: 96, height: 104),
                CGRect(x: 350, y: 50, width: 96, height: 104), CGRect(x: 10, y: 310, width: 96, height: 104)].map { cursorDragArtAllowed($0, excluding: avoid) }
        } else if let size = data["badgeCheck"] as? [Double], size.count == 2 {
            let view = CursorPauseView(control, current: { true })
            view.frame = CGRect(x: 0, y: 0, width: size[0], height: size[1])
            view.hitOpaque = { [weak view] point in view.map { cursorBadgeHit(point, $0.bounds) } ?? false }
            let badge = cursorBadgeRect(view.bounds)
            output["badgeHit"] = view.hitTest(CGPoint(x: badge.midX, y: badge.midY)) === view
            var hits = 0, samples = 0, seed: UInt64 = 1707
            while samples < 200 {
                seed = seed &* 6364136223846793005 &+ 1
                let x = Double(seed % 100000) / 100000 * size[0]
                seed = seed &* 6364136223846793005 &+ 1
                let point = CGPoint(x: x, y: Double(seed % 100000) / 100000 * size[1])
                if badge.contains(point) { continue }
                samples += 1; if view.hitTest(point) != nil { hits += 1 }
            }
            output["outsideHits"] = hits; output["samples"] = samples; output["badgeSize"] = [badge.width, badge.height]
        } else if data["hintTargetCheck"] as? Bool == true {
            let point = CGPoint(x: 100, y: 200)
            let bounds: [String: Any] = ["X": 0, "Y": 0, "Width": 500, "Height": 500]
            let app: [String: Any] = [kCGWindowOwnerPID as String: 42, kCGWindowNumber as String: UInt32(77), kCGWindowLayer as String: 0, kCGWindowBounds as String: bounds]
            var card = app; card[kCGWindowOwnerPID as String] = Int(getpid()); card[kCGWindowLayer as String] = NSWindow.Level.modalPanel.rawValue
            var overlay = app; overlay[kCGWindowLayer as String] = 8
            output["app"] = cursorHintTarget(at: point, snapshot: [app])
            output["card"] = cursorHintTarget(at: point, snapshot: [card, app]) as Any? ?? NSNull()
            output["desktop"] = cursorHintTarget(at: point, snapshot: []) as Any? ?? NSNull()
            output["overlay"] = cursorHintTarget(at: point, snapshot: [overlay, app]) as Any? ?? NSNull()
        } else if data["cardDropCheck"] as? Bool == true || data["hintDragCheck"] as? Bool == true || data["queuedDragCheck"] as? Bool == true {
            // Construct unposted events. The source PID is changed in memory for a hardware positive control.
            func event(_ type: CGEventType, pid: Int64 = 0) -> NSEvent {
                clock += 0.01
                let cg = CGEvent(keyboardEventSource: CGEventSource(stateID: .hidSystemState)!, virtualKey: 0, keyDown: true)!
                cg.type = type; cg.timestamp = UInt64(clock * 1e9)
                cg.setIntegerValueField(.eventSourceUnixProcessID, value: pid); cg.setIntegerValueField(.eventSourceUserData, value: 0)
                return NSEvent(cgEvent: cg)!
            }
            if data["queuedDragCheck"] as? Bool == true {
                let host = HandHost(); host.ownPause.now = { clock }; host.ownPause.nonce = { String(repeating: "a", count: 64) }; host.ownPause.schedule = { _, _ in }
                var hints = 0, states: [Bool] = []
                host.ownPause.send = { frame in if frame["hand"] as? String == "hint" { hints += 1 }; return true }
                host.ownPause.changed = { _ in host.badgeDrag.settle() }
                host.pauseVisibility.clear()
                _ = host.badgeDrag.begin(event(.leftMouseDown), windowMatches: true)
                let act = HandAct(seq: 1, kind: "click", pid: 42, windowId: 77, at: .zero, path: [], delay: 0, beats: 1)
                let aim = RingEvent(seq: 2, state: "aim", pid: 42, windowId: 77, at: .zero, rect: nil, label: nil)
                func queued() { host.receiveAct(act); host.receiveCursor(aim); states.append(host.badgeDrag.active) }
                func ack() { if let request = host.ownPause.pending { host.ownPause.receive("ready", token: request.token, value: request.value); host.ownPause.receive("applied", token: request.token, value: request.value) } }
                queued(); ack(); queued()
                _ = host.badgeDrag.end(event(.leftMouseUp), windowMatches: true, target: ["pid": 42, "windowId": 77, "at": [100, 200]])
                ack()
                output["active"] = states; output["hints"] = hints; output["cleared"] = host.pauseVisibility.cleared
                output["paused"] = host.ownPause.paused; output["windows"] = host.panel == nil && host.pauseOverlay.panel == nil ? 0 : 1
            } else if data["cardDropCheck"] as? Bool == true {
                var answers = 0
                let synthetic = personActivation(event(.leftMouseUp, pid: 1234), windowMatches: true, now: clock, consent: true)
                if synthetic { answers += 1 }
                output["syntheticAccepted"] = synthetic
                output["hardwareAccepted"] = personActivation(event(.leftMouseUp), windowMatches: true, now: clock, consent: true)
                output["answers"] = answers
            } else {
                let pause = CursorPauseControl(); pause.now = { clock }; pause.nonce = { String(repeating: "a", count: 64) }; pause.schedule = { _, _ in }
                pause.set(data["alreadyPaused"] as? Bool == true)
                let drag = CursorBadgeDrag(pause); drag.epoch = { 100000 }
                var timers: [(delay: Double, deadline: Double, task: () -> Void)] = [], cancelledTimers = 0, finishes = 0
                drag.schedule = { delay, task in
                    timers.append((delay, clock + delay, task)); return { cancelledTimers += 1 }
                }
                drag.finished = { finishes += 1 }
                var states: [Bool] = [], hints: [[String: Any]] = [], pausedAtHint = false, appliedToken: String?
                pause.changed = { value in states.append(value); drag.settle() }
                pause.send = { frame in if frame["hand"] as? String == "hint" { hints.append(frame); pausedAtHint = pause.paused }; return true }
                _ = drag.begin(event(.leftMouseDown), windowMatches: true)
                func ack() {
                    if let request = pause.pending { pause.receive("ready", token: request.token, value: request.value); pause.receive("applied", token: request.token, value: request.value) }
                }
                let failure = data["heldFailure"] as? String
                appliedToken = pause.pending?.token
                if failure != "expire" { ack() }
                let target: [String: Any]? = data["desktop"] as? Bool == true ? nil : ["pid": 42, "windowId": 77, "at": [100, 200]]
                if failure == "expire" { clock += 0.501; pause.expire() }
                else if failure == "aborted", let token = appliedToken { pause.receive("aborted", token: token, value: true) }
                else if data["abandon"] as? Bool == true {
                    let deadline = timers[0].deadline
                    clock = deadline - 0.001
                    for timer in timers where timer.deadline <= clock { timer.task() }
                    output["activeBeforeTimeout"] = drag.active
                    output["timeoutSeconds"] = timers[0].delay
                    clock = deadline
                    for timer in timers where timer.deadline <= clock { timer.task() }
                    output["activeAtTimeout"] = drag.active
                    _ = drag.begin(event(.leftMouseDown), windowMatches: true)
                    timers[0].task() // Even an already queued old callback cannot cancel the next drag.
                    output["activeAfterOldTimer"] = drag.active
                    drag.cancel()
                } else {
                    if data["badDrop"] as? Bool == true {
                        let view = CursorPauseView(pause, current: { true }); view.drag = drag
                        view.mouseUp(with: event(.leftMouseUp, pid: 1234))
                    } else { _ = drag.end(event(.leftMouseUp), windowMatches: true, target: target) }
                    ack()
                }
                output["states"] = states; output["hints"] = hints; output["pausedAtHint"] = pausedAtHint
                output["active"] = drag.active; output["paused"] = pause.paused; output["failed"] = pause.failed
                output["finishes"] = finishes; output["cancelledTimers"] = cancelledTimers
            }
        } else if data["alphaCheck"] as? Bool == true {
            // Synthetic RGBA bytes, no graphics context or drawing.
            var pixels = [UInt8](repeating: 0, count: 16 * 2 * 4)
            pixels[7] = 255; pixels[(16 + 0) * 4 + 3] = 128
            let provider = CGDataProvider(data: Data(pixels) as CFData)!
            let image = CGImage(width: 16, height: 2, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 64,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
            func mask(_ flip: Bool) -> CursorPauseMask { CursorPauseMask(image: image, cell: CGSize(width: 2, height: 2), row: 0, column: 0,
                scale: 2, flip: flip, origin: CGPoint(x: 10, y: 20)) }
            output["opaque"] = mask(false).contains(CGPoint(x: 12, y: 20))
            output["transparent"] = mask(false).contains(CGPoint(x: 10, y: 20))
            output["translucent"] = mask(false).contains(CGPoint(x: 10, y: 22))
            output["outside"] = mask(false).contains(CGPoint(x: 14, y: 20))
            output["flipped"] = mask(true).contains(CGPoint(x: 10, y: 20))
        } else if let validity = data["validity"] as? [String: Any] {
            guard let expected = rect(validity["expected"]) else { exit(65) }
            output["current"] = cursorPauseCurrent(expected, rect(validity["observed"]))
        } else if let idle = data["idleMs"] as? Double, idle >= 100, idle <= 5000 {
            var before = rusage(), after = rusage(); getrusage(RUSAGE_SELF, &before)
            let start = ProcessInfo.processInfo.systemUptime
            // Dispatch and Foundation only, with the control instantiated. No application or windows.
            let deadline = Date(timeIntervalSinceNow: idle / 1000)
            let timer = Timer(fire: deadline, interval: 0, repeats: false) { _ in }
            RunLoop.current.add(timer, forMode: .default)
            RunLoop.current.run(until: deadline); timer.invalidate()
            getrusage(RUSAGE_SELF, &after)
            func cpu(_ value: rusage) -> Double { Double(value.ru_utime.tv_sec + value.ru_stime.tv_sec) + Double(value.ru_utime.tv_usec + value.ru_stime.tv_usec) / 1e6 }
            let elapsed = ProcessInfo.processInfo.systemUptime - start
            output["idleSeconds"] = elapsed; output["cpuSeconds"] = cpu(after) - cpu(before)
            output["cpuPercent"] = (cpu(after) - cpu(before)) / elapsed * 100; output["maxRssBytes"] = after.ru_maxrss
            var info = mach_task_basic_info(), count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
            let status = withUnsafeMutablePointer(to: &info) { pointer in
                pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count) }
            }
            if status == KERN_SUCCESS { output["rssBytes"] = info.resident_size }
            output["controls"] = 1; output["windows"] = 0
        } else if data["click"] != nil || data["ack"] != nil || data["expire"] != nil || data["ax"] != nil || data["oldTimer"] != nil || data["aborted"] != nil {
            emitted = []
            if let click = data["click"] as? [String: Any] {
                clock += 0.01
                var event: NSEvent?
                if click["reuse"] as? Bool == true { event = lastEvent }
                else if click["nil"] as? Bool != true {
                    let source = CGEventSource(stateID: click["wrongSource"] as? Bool == true ? .privateState : .hidSystemState)!
                    let cg = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(click["key"] as? Int ?? 49), keyDown: true)!
                    cg.type = click["type"] as? String == "key" ? .keyDown : .leftMouseUp
                    cg.setIntegerValueField(.eventSourceUnixProcessID, value: (click["pid"] as? NSNumber)?.int64Value ?? 1234)
                    cg.setIntegerValueField(.eventSourceUserData, value: (click["userData"] as? NSNumber)?.int64Value ?? 0)
                    cg.timestamp = UInt64(max(0, clock - (click["age"] as? Double ?? 0)) * 1e9)
                    event = NSEvent(cgEvent: cg); lastEvent = event
                }
                control.nonce = { click["noNonce"] as? Bool == true ? nil : String(repeating: "a", count: 64) }
                if click["consumer"] as? String == "shared" {
                    output["accepted"] = personActivation(event, windowMatches: click["wrongWindow"] as? Bool != true,
                        highlighted: click["unhighlighted"] as? Bool != true, accessibility: click["ax"] as? Bool == true,
                        now: clock, windowNumber: click["windowNumber"] as? Int)
                } else {
                    output["accepted"] = control.click(event, windowMatches: click["wrongWindow"] as? Bool != true,
                        highlighted: click["unhighlighted"] as? Bool != true, accessibility: click["ax"] as? Bool == true)
                }
            }
            if data["ack"] as? Bool == true, let request = control.pending {
                control.receive("ready", token: request.token, value: request.value)
                control.receive("applied", token: request.token, value: request.value)
                appliedToken = request.token; appliedValue = request.value
            }
            if data["oldTimer"] as? Bool == true, !scheduled.isEmpty { scheduled.removeFirst()() }
            if data["aborted"] as? Bool == true, let token = appliedToken { control.receive("aborted", token: token, value: appliedValue) }
            if data["expire"] as? Bool == true { clock += 0.501; control.expire() }
            if data["ax"] as? Bool == true {
                let item = CursorPauseMenuItem(title: "Resume sleight", action: nil, keyEquivalent: "")
                var refused = 0; item.refused = { refused += 1 }
                output["axPress"] = item.accessibilityPerformPress(); item.accessibilityPerformAction(.press)
                output["axRefusals"] = refused
            }
            output["paused"] = control.paused; output["failed"] = control.failed; output["pending"] = control.pending != nil
            output["events"] = emitted
        } else {
            guard let at = data["at"] as? [Double], at.count == 2, let size = data["size"] as? [Double], size.count == 2,
                let clip = data["clip"] as? [Double], clip.count == 4,
                (at + size + clip).allSatisfy({ $0.isFinite && abs($0) <= 100000 }) else { exit(65) }
            let rect = cursorPauseRect(at: CGPoint(x: at[0], y: at[1]), size: CGSize(width: size[0], height: size[1]),
                clip: CGRect(x: clip[0], y: clip[1], width: clip[2], height: clip[3]), drag: data["drag"] as? Bool ?? false)
            output["rect"] = rect.map { [$0.minX, $0.minY, $0.width, $0.height] } as Any? ?? NSNull()
        }
        guard let result = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(result + Data([10]))
    }
}
// END CURSOR PAUSE PANEL

final class HandHost: NSObject, NSApplicationDelegate {
    var unknownAppHidden = false
    // A routine mood cannot re-use an old app after an unlocated call hid the character.
    // Existing producer authority still owns its terminal. An ordinary terminal may
    // release protection without presenting that old app again.
    func keepUnknownAppHidden(_ event: RingEvent) -> Bool {
        if unknownAppHidden, !producer.active, event.state == "handback" || event.state == "done" && !event.ok {
            perch.stage.completeTurn(state: event.state, ok: event.ok, now: perch.now)
            return true
        }
        if event.area != nil && event.state == "thinking" || event.state == "aim" || handKinds.contains(event.state) {
            unknownAppHidden = false
        }
        guard unknownAppHidden, !producer.active else { return false }
        perch.stage.completeTurn(state: event.state, ok: event.ok, now: perch.now)
        return true
    }
    var producer = StageProducerState()
    var producerAck: (([String: Any]) -> Void)?
    var readerFaulted: (() -> Void)?, readerFinished: (() -> Void)?
    var ringEffects: (([(Double, RingEffect)]) -> Void)?
    var ringEnvironmentProvider: (() -> RingEnvironment)?
    func finishProducer(terminal: RingEvent? = nil) {
        let event = terminal.flatMap { ev in ev.at.map { at in
            PerchEvent(state: ev.state, pid: ev.pid, window: ev.windowId, at: at, ok: false, drop: nil, end: nil)
        } }
        perch.stage.completeTurn(state: terminal?.state ?? "handback", ok: false, now: perch.now, terminal: event)
        perch.stage.producerOwner = nil
        perch.stage.producerCollectionOnly = false
        producer.finish()
    }
    func producerHide() {
        perch.stage.producerCollectionOnly = true
        perch.performStage(perch.stage.hide("producer-uncertain", immediate: true))
        hide()
    }
    // The same parser, shared sequence predicate and main-queue entry serve stdin and the offline dump.
    func receiveProducer(_ f: StageProducerFrame) {
        // A completed identity cannot acquire ownership again, even before its ack reaches the client.
        if producer.endedIdentities.contains(StageProducerIdentity(session: f.session, turn: f.turn)) {
            guard handSequenceFresh(f.seq, after: producer.last) else { return }
            producer.last = f.seq
            if var event = f.target {
                event.producer = producer.active ? StageProducerIdentity(session: f.session, turn: f.turn) : nil
                let terminal = event.state == "handback" || event.state == "done" && !event.ok
                if producer.active, !terminal, event.at != nil, !handKinds.contains(event.state), event.state != "aim" {
                    // A foreign status target is ordinary protection, never this producer's art-only anchor.
                    producer.failed = true; producerHide(); admitPausedStage(event, ordinary: true)
                }
                receiveCursor(event)
            }
            let ack: [String: Any] = ["hand": "stage-producer-ack", "nonce": f.nonce, "session": f.session, "turn": f.turn,
                "seq": f.seq, "op": f.op, "accepted": f.op == "public"]
            if let send = producerAck { send(ack) } else { writeStageProducerAck(ack) }
            return
        }
        // Status-only traffic preserves the ring's anchor and narration. Begin/fault already hid the character.
        if f.op != "public" || !producer.active { producerHide() }
        var accepted = false
        defer {
            if !accepted {
                producer.failed = true
                if !producer.active {
                    producer.session = f.session; producer.turn = f.turn
                    perch.stage.producerOwner = producer.identity
                }
            }
            let ack: [String: Any] = ["hand": "stage-producer-ack", "nonce": f.nonce, "session": f.session, "turn": f.turn,
                "seq": f.seq, "op": f.op, "accepted": accepted]
            if let send = producerAck { send(ack) }
            else { writeStageProducerAck(ack) }
        }
        guard handSequenceFresh(f.seq, after: producer.last) else { return }
        producer.last = f.seq
        if f.op == "fault" { return }
        if f.op == "public", var event = f.target {
            guard producer.session == f.session, producer.turn == f.turn else { return }
            event.producer = producer.identity
            if event.state == "handback" || event.state == "done" && !event.ok { finishProducer(terminal: event) }
            receiveCursor(event)
            accepted = true; return
        }
        guard !producer.failed else { return }
        if f.op == "begin" {
            guard producer.turn == nil, producer.session == nil,
                !producer.ended.contains(f.turn),
                perch.stage.requiredReferences.values.allSatisfy({ $0.isEmpty }), perch.stage.turnTargets.isEmpty else { return }
            producer.session = f.session; producer.turn = f.turn; producer.epoch = 0; producer.after = -1
            perch.stage.producerOwner = producer.identity
            producer.barrier = f.barrier
            producer.prefix = nil; producer.observation = 0; producer.acquiredEnd = -1; producer.baselineLost = false
            producer.baselines = [:]; producer.contents = [:]; producer.observations = [:]; producer.references = [:]; producer.attempts = []; accepted = true; return
        }
        guard producer.session == f.session, producer.turn == f.turn else { return }
        if f.op == "end" {
            finishProducer()
            accepted = true; return
        }
        if f.op == "admit", let target = f.target, let prefix = f.prefix {
            // Even a rejected ordinal/attempt remains protected until the attributed turn end.
            admitPausedStage(target)
            guard prefix.ordinal == (producer.prefix?.ordinal ?? 0) + 1, producer.references.count < 512,
                !producer.attempts.contains(where: { $0.call == prefix.call && $0.action == prefix.action && $0.attempt == prefix.attempt }) else { return }
            let key = StageWindowKey(pid: target.pid, window: target.windowId)
            if producer.baselines[key] == nil { producer.baselineLost = true }
            // Record through the production admission transaction, including coalesced and unmappable references.
            guard perch.stage.requiredReferences[key, default: []].contains(where: { $0.seq == f.seq }), !perch.stage.targetCapacity else { return }
            guard f.barrier >= producer.barrier else { return }
            producer.barrier = f.barrier
            producer.references[f.seq] = key; producer.after = f.seq; producer.prefix = prefix; producer.attempts.append(prefix)
            accepted = true; return
        }
        guard f.after == producer.after, f.prefix == producer.prefix else { return }
        if f.op == "invalidate" {
            guard f.epoch == producer.epoch + 1, f.barrier >= producer.barrier else { return }
            producer.epoch = f.epoch
            producer.barrier = f.barrier
            for key in Set(producer.references.values) { perch.stage.invalidateGeometry(key) }
            accepted = true; return
        }
        guard f.op == "certificate", let proof = f.geometry, f.epoch == producer.epoch,
            f.observation > producer.observation, f.acquired[0] >= producer.acquiredEnd, f.acquired[0] >= producer.barrier,
            !producer.baselineLost, !perch.stage.targetCapacity, !perch.stage.windowBook.discontinuous.contains(proof.key),
            !perch.stage.unmappableDrags.contains(proof.key) else { return }
        let ev = PerchEvent(state: "thinking", pid: proof.key.pid, window: proof.key.window,
            at: CGPoint(x: proof.bounds.midX, y: proof.bounds.midY), ok: false, drop: nil, end: nil, windowRect: proof.bounds)
        let previous = perch.stage.event; perch.stage.event = ev
        let world = admissionWorld.map { $0(ev) } ?? perch.stageEnvironment()
        perch.stage.event = previous
        guard let world = world, world.windows?[proof.key] == proof.bounds else { return }
        perch.stage.bindWindows(world)
        guard !perch.stage.windowBook.discontinuous.contains(proof.key) else { return }
        if proof.mode == "baseline" {
            guard producer.after == -1, producer.references.isEmpty, perch.stage.turnTargets.isEmpty,
                producer.baselines[proof.key] == nil, producer.baselines.count < 128, proof.references.isEmpty else { return }
            producer.baselines[proof.key] = proof.incarnation; producer.contents[proof.key] = proof.content
        } else {
            guard producer.baselines[proof.key] == proof.incarnation, let content = producer.contents[proof.key],
                proof.mode == "move" ? proof.content == content : proof.content >= content else { return }
            let expected = Set(producer.references.filter { $0.value == proof.key }.keys)
            let retained = Set(perch.stage.requiredReferences[proof.key, default: []].map { $0.seq })
            guard Set(proof.references.map { $0.seq }) == expected, expected == retained,
                proof.references.allSatisfy({ $0.departed || $0.rects.allSatisfy({ $0.intersects(proof.bounds) }) }) else { return }
        }
        // Collection only. GP4 must establish presentation ordering before any remap can restore visibility.
        producer.observations[proof.key] = proof
        producer.contents[proof.key] = proof.content
        producer.observation = f.observation; producer.acquiredEnd = f.acquired[1]; accepted = true
    }

    private lazy var glideStop = GlideStopControl(send: writeGlideStop)
    let pauseOverlay = CursorPauseOverlay(), ownPause = CursorPauseControl()
    lazy var badgeDrag: CursorBadgeDrag = {
        let drag = CursorBadgeDrag(pauseControl)
        drag.finished = { [weak self] in
            guard let self = self else { return }
            self.endBadgeArt()
            if self.pauseControl.paused && !self.captureHeld { self.pauseChanged(true) }
        }
        return drag
    }()
    var badgeArt: HandPanel?
    var pauseVisibility = CursorPauseVisibility()
    var pauseControl: CursorPauseControl { consent?.cursorPause ?? ownPause }
    var pauseTarget: RingEvent?
    // Dependency injection keeps metadata-only host entry points usable without WindowServer.
    var admissionWorld: ((PerchEvent) -> StageWorld?)?
    func pauseChanged(_ paused: Bool) {
        let target = pauseTarget
        if badgeDrag.active {
            badgeDrag.settle()
            if badgeDrag.active { consent?.rebuildMenu(); return }
        }
        if perch.stageActive && !pauseControl.failed {
            pauseStage(paused); consent?.rebuildMenu(); return
        }
        hide()
        if cursorStyle != "glove", paused || pauseControl.failed, let target = target {
            let event = RingEvent(seq: target.seq, state: paused ? "paused" : "error", pid: target.pid, windowId: target.windowId, at: target.at, rect: nil, label: nil)
            ringFrame(event, delay: 0)
        }
        consent?.rebuildMenu()
    }
    var settingsMenu = false
    var cursorStyle = "glove" { didSet { if cursorStyle != "sprite" { spriteLoader.cancel(); ringRuntime.character = nil; perch.configure(replace: true) } } }
    let honestMood = HonestMoodCells()
    lazy var edgeChips = EdgeChipHost(host: self)
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
    let narrator = LocalNarrator()
    var narrationWatch: DispatchWorkItem?
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
        if cursorStyle == "sprite" { perch.stageCall.prefetch(CACurrentMediaTime()) }
        consent?.applicationDidFinishLaunching(notification)
        pauseControl.changed = { [weak self] paused in self?.pauseChanged(paused) }
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
                self.edgeChips.refresh()
                DistributedNotificationCenter.default().postNotificationName(Notification.Name(name + ".ack"), object: token, userInfo: nil, deliverImmediately: true)
            } else if parts[0] == "end" { self.captureHolds.removeValue(forKey: token); self.edgeChips.refresh() }
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
            if let failed = readerFaulted { DispatchQueue.main.async(execute: failed); return }
            DispatchQueue.main.async { self.glideStop.close(); self.consent?.retireControl(); writeHandControlGone(); if self.consent?.consentOpen == true { self.hide(); self.consent?.handGone() } else { exit(65) } }
        }
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty {
                if let finished = readerFinished { DispatchQueue.main.async(execute: finished); return }
                let retired = faulted
                DispatchQueue.main.async { self.glideStop.close(); if !retired && self.consent?.consentOpen == true { self.hide(); self.consent?.handGone() } else { NSApp.terminate(nil) } }
                return
            }
            if faulted { continue }
            buffer.append(chunk)
            if buffer.count > 131072 { fault(); continue }
            lines: while !faulted, let end = buffer.firstIndex(of: 10) {
                let line = buffer.prefix(upTo: end)
                buffer.removeSubrange(...end)
                if line.count <= 8192, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any], data["hand"] as? String == "glide-stop" {
                    guard !settingsMenu, let frame = GlideStopFrame.parse(data), nonceBook.admit("hand", frame.nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        if channelValidationOnly { writeGlideStop(["hand": "glide-stop", "nonce": frame.nonce, "token": frame.token, "phase": "unavailable"]) }
                        else { self.glideStop.receive(frame) }
                    }
                    continue
                }
                if line.count < 65536, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any], data["hand"] as? String == "stage-producer" {
                    guard !settingsMenu, let frame = StageProducerFrame.parse(data, bytes: line.count + 1), nonceBook.admit("hand", frame.nonce),
                        handSequenceFresh(frame.seq, after: last) else { fault(); continue lines }
                    last = frame.seq
                    DispatchQueue.main.async { self.receiveProducer(frame) }
                    continue
                }
                if line.count <= 65536, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any], data["hand"] as? String == "stage-geometry" {
                    guard !settingsMenu, let (nonce, seq, proof) = stageGeometryFrame(data), nonceBook.admit("hand", nonce), handSequenceFresh(seq, after: last) else { fault(); continue lines }
                    last = seq
                    DispatchQueue.main.async { self.receiveGeometry(proof) }
                    continue
                }
                guard line.count <= 65536, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                    line.count <= 8192 || data["hand"] as? String == "character" && line.count <= 32768 || data["hand"] as? String == "picker",
                    let frame = handFrame(data) else { fault(); continue lines }
                if settingsMenu && !["menu", "picker", "hide"].contains(data["hand"] as? String ?? "") { fault(); continue lines }
                switch frame {
                case let .edge(nonce, message):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { self.edgeChips.receive(message) }
                case let .pause(nonce, phase, token, value):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { self.pauseControl.receive(phase, token: token, value: value) }
                case let .clear(nonce, token):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        self.pauseVisibility.clear()
                        if data["keepStage"] as? Bool == true && self.perch.stageActive {
                            // The local helpers exclude our PID. Keep the safely seated stage panel, while
                            // clearing the pointer marker and every input-taking pause control as before.
                            self.pending.values.forEach { $0.cancel() }; self.pending.removeAll()
                            self.ringWake?.cancel(); self.ringWake = nil; _ = self.ringRuntime.hide(0)
                            self.fading?.cancel(); self.release(); self.pauseOverlay.hide(); self.edgeChips.hide()
                        } else { self.hide() }
                        // Earlier action frames have run on this queue. Commit their panel placement
                        // before releasing the existing bounded local-input wait.
                        if data["placed"] as? Bool == true {
                            _ = self.placeLocalTarget((data["placementSeq"] as? NSNumber)?.intValue ?? -1)
                            CATransaction.flush()
                        }
                        if let bytes = try? JSONSerialization.data(withJSONObject: ["hand": data["placed"] as? Bool == true ? "placed-ready" : "clear-ready", "nonce": nonce, "token": token]) {
                            FileHandle.standardOutput.write(bytes + Data([10]))
                        }
                    }
                case let .activity(nonce):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { self.consent?.cursorControlSession = true; self.consent?.rebuildMenu() }
                case let .call(nonce):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { if self.cursorStyle == "sprite" { self.perch.stageCall.prefetch(CACurrentMediaTime()) } }
                case let .picker(nonce, message):
                    guard nonceBook.admit("hand", nonce), message.op != "input-check" else { fault(); continue lines }
                    DispatchQueue.main.async {
                        if message.op == "style", let style = message.data["style"] as? String {
                            self.hide(); self.cursorStyle = style
                            // A new runtime keeps the menu frame's narration options, which arrive only with the next menu frame.
                            let narration = self.ringRuntime.narration
                            self.ringRuntime = RingRuntime(theme: ringThemes[style] ?? .seamPlus, seed: UInt64.random(in: 1...UInt64.max))
                            self.ringRuntime.narration = narration
                            self.consent?.cursorPicker.rows = CursorPickerRow.defaults(style)
                        } else if message.op == "options" {
                            self.perch.configure(perch: message.data["perch"] as? Bool, lines: message.data["lines"] as? Bool)
                        } else { self.consent?.cursorPicker.receive(message) }
                    }
                case let .narrationCheck(nonce, token):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        narrationJSON(["hand": "narration-check", "nonce": nonce, "token": token, "secure": IsSecureEventInputEnabled()])
                    }
                case let .character(nonce, value):
                    guard nonceBook.admit("hand", nonce), handSequenceFresh(value.seq, after: last) else { fault(); continue lines }
                    last = value.seq
                    DispatchQueue.main.async {
                        if self.producer.active { self.producer.failed = true; self.producerHide(); return }
                        self.ringRoot?.sublayers?.filter { $0.name == "sprite" }.forEach { $0.removeFromSuperlayer() }
                        self.ringRuntime.character = nil; self.perch.configure(replace: true)
                        guard self.cursorStyle == "sprite" else { self.spriteLoader.cancel(); return }
                        // The decode runs off the main thread. Until it's done the ring draws alone; the sprite joins at
                        // the next frame after it.
                        self.spriteLoader.start(value) { generation, result in
                            DispatchQueue.main.async {
                                guard self.spriteLoader.isCurrent(generation), self.cursorStyle == "sprite" else { return }
                                if self.producer.active { self.producer.failed = true; self.producerHide(); return }
                                self.perch.configure(character: result.character, replace: true); writeCharacterResult(value.id, result)
                            }
                        }
                    }
                case let .hide(nonce):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        self.hide()
                        if data["reason"] as? String == "unknown-app" {
                            self.unknownAppHidden = true
                            _ = self.perch.stage.hide("unknown-app", immediate: true, at: self.perch.now)
                            self.perch.lastHideReason = "unknown-app"
                        }
                    }
                case let .act(nonce, act):
                    guard nonceBook.admit("hand", nonce), handSequenceFresh(act.seq, after: last) else { fault(); continue lines }
                    last = act.seq
                    DispatchQueue.main.async { self.receiveAct(act) }
                case let .aim(nonce, event), let .status(nonce, event):
                    guard nonceBook.admit("hand", nonce), handSequenceFresh(event.seq, after: last) else { fault(); continue lines }
                    last = event.seq
                    DispatchQueue.main.async { self.receiveCursor(event) }
                case let .menu(nonce, enabled, capture, version, permissions, usage):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async {
                        if let options = NarrationOptions.parse(data) {
                            self.ringRuntime.narration = options; self.narrator.configure(options)
                            if options.mode == "off" { self.ringRoot?.sublayers?.filter { ["narration", "oldNarration", "narrationTether"].contains($0.name ?? "") }.forEach { $0.removeFromSuperlayer() } }
                        }
                        self.capture = capture
                        if let panel = self.panel { panel.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none }
                        self.pauseOverlay.panel?.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none
                        // The character panel takes the new mode now, not at its next install (a parked stage character
                        // may not reinstall for a while, and hidden must apply at once).
                        self.perch.panel?.sharingType = handCaptureModes[capture] ?? NSWindow.SharingType.none
                        if !enabled { self.hide() }
                        self.consent?.handState(enabled: enabled, version: version, permissions: permissions, usage: usage)
                    }
                }
            }
        }
    }
    // A frame plays after its delay unless a hide comes first. Past 64 waiting frames, new ones are dropped.
    func schedule(_ act: HandAct) {
        if channelValidationOnly { return }
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
        badgeDrag.cancel()
        // Cancelling a drag can refresh chips while restoring the paused pose.
        edgeChips.hide()
        narrator.stop(); narrationWatch?.cancel(); narrationWatch = nil
        pending.values.forEach { $0.cancel() }; pending.removeAll()
        ringWake?.cancel(); ringWake = nil; _ = ringRuntime.hide(0)
        fading?.cancel(); release(); perch.takeDown()
    }
    func pauseStage(_ paused: Bool) {
        narrator.stop(); narrationWatch?.cancel(); narrationWatch = nil
        pending.values.forEach { $0.cancel() }; pending.removeAll()
        ringWake?.cancel(); ringWake = nil; _ = ringRuntime.hide(0)
        fading?.cancel(); release()
        perch.performStage(perch.stage.setPaused(paused, now: perch.now, world: perch.stageEnvironment(), reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
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
    // Only while a bubble or utterance exists. No idle timer and no secure-input text left parked on screen.
    func watchNarration() {
        narrationWatch?.cancel(); narrationWatch = nil
        guard ringRoot?.sublayers?.contains(where: { $0.name == "narration" }) == true || narrator.queue.active != nil else { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self = self else { return }
            if IsSecureEventInputEnabled() {
                self.ringRoot?.sublayers?.filter { ["narration", "oldNarration", "narrationTether", "chip", "tether", "oldChip", "oldTether"].contains($0.name ?? "") }.forEach { $0.removeFromSuperlayer() }
                self.narrator.stop()
            } else if self.narrator.tick() {
                self.ringRoot?.sublayers?.filter { ["narration", "oldNarration", "narrationTether"].contains($0.name ?? "") }.forEach { $0.removeFromSuperlayer() }
            }
            self.watchNarration()
        }
        narrationWatch = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1, execute: item)
    }
    // The ring: the runtime decides, this adapter installs plans on one clipped panel with a flipped root, so all geometry
    // keeps the wire's top-left coordinates. One one-shot wake-up serves the runtime's earliest pending act or timer.
    var ringEnvironment: RingEnvironment {
        if let environment = ringEnvironmentProvider { return environment() }
        return RingEnvironment(bounds: { pid, window in handWindowBounds(window, pid: pid) },
            reduced: { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }, secure: { IsSecureEventInputEnabled() })
    }
    func ringFrame(_ event: RingEvent, delay: Double) {
        if producer.active && (handKinds.contains(event.state) || event.state == "aim") { producer.failed = true; producerHide(); admitPausedStage(event); return }
        if channelValidationOnly { return }
        // Turn completion releases geometry even when no ring can draw (closed window, capture or pause).
        if !producer.active { perch.stage.completeTurn(state: event.state, ok: event.ok, now: perch.now) }
        if pauseControl.paused && event.state != "paused" && !producer.active { admitPausedStage(event); return }
        if badgeDrag.active || captureHeld { admitPausedStage(event); return }
        ringRuntime.dissolveAt = perch.dissolve(event)
        ringPerform(ringRuntime.receive(event, delay: delay, now: CACurrentMediaTime(), ringEnvironment))
        ringWakeUp()
    }
    func ringWakeUp() {
        if ringEffects != nil { return }
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
        if let deliver = ringEffects { deliver(effects); return }
        for (_, effect) in effects {
            switch effect {
            case let .draw(plan, frame):
                if captureHeld { hide(); return }
                honestMood.receive(plan, now: CACurrentMediaTime())
                edgeChips.aim = plan.rect ?? stagePointRect(plan.at, 48)
                edgeChips.refresh()
                installRing(plan, frame: frame); perch.ringDrew(plan)
                narrator.speakingChanged = { [weak self] active in self?.voiceBars(active) }
                narrator.offer(plan.bubble?.spoken)
                voiceBars(narrator.speaking)
                watchNarration()
            case .hide, .release: release()
            case .drop: break
            case .park:
                func strip(_ layer: CALayer) { if layer.name?.hasPrefix("voiceBar") == true && layer.superlayer?.name == "narration" { return }; layer.removeAllAnimations(); layer.sublayers?.forEach(strip) }
                ringRoot?.sublayers?.forEach(strip)
            case let .fade(duration):
                pauseOverlay.hide()
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
    func voiceBars(_ active: Bool) {
        guard let bubble = ringRoot?.sublayers?.first(where: { $0.name == "narration" }),
            let text = bubble.sublayers?.first(where: { $0.name == "narrationText" }) as? CATextLayer,
            let frame = ringRuntime.session.previous?.bubble?.frame else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        bubble.sublayers?.filter { $0.name?.hasPrefix("voiceBar") == true }.forEach { $0.removeFromSuperlayer() }
        text.frame = frame.insetBy(dx: 9, dy: 6).offsetBy(dx: -box.minX, dy: -box.minY)
        if active {
            text.frame.origin.x += 12; text.frame.size.width -= 12
            for (i, height) in [5.0,9,6].enumerated() {
                let bar = CALayer(); bar.name = "voiceBar\(i)"; bar.anchorPoint = CGPoint(x: 0.5, y: 1)
                bar.bounds = CGRect(x: 0, y: 0, width: 2, height: height)
                bar.position = CGPoint(x: frame.minX + 10 + Double(i) * 3 - box.minX, y: frame.minY + 17 - box.minY)
                bar.backgroundColor = CGColor(red: 91.0/255, green: 141.0/255, blue: 1, alpha: 1)
                if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                    let animation = CAKeyframeAnimation(keyPath: "transform.scale.y")
                    animation.values = [1,0.45,1]; animation.keyTimes = [0,0.5,1]; animation.duration = 0.6
                    animation.beginTime = CACurrentMediaTime() - Double(i) * 0.15; animation.repeatCount = .infinity
                    bar.add(animation, forKey: "speaking")
                }
                bubble.addSublayer(bar)
            }
        }
        CATransaction.commit()
    }
    func hideRingCharacter() {
        guard ringRoot?.sublayers?.contains(where: { $0.name == "sprite" }) == true else { return }
        ringRoot?.sublayers?.filter { ["sprite", "narration", "oldNarration", "narrationTether"].contains($0.name ?? "") || ($0.name ?? "").hasPrefix("honest-") }.forEach { $0.removeFromSuperlayer() }
        perch.closeBubble()
    }
    func installRing(_ plan: RingPlan, frame: CGRect) {
        pauseOverlay.hide()
        fading?.cancel(); fading = nil
        let panel = self.panel ?? makeHandPanel(capture: capture)
        let previousBox = box
        self.panel = panel; box = frame
        panel.setFrame(appKitRect(frame), display: false)
        // A changed label carries the old chip and tether over to fade out.
        var carried = plan.oldLabel == nil ? [] : [("oldChip", ringLabel), ("oldTether", ringTether)].compactMap { name, layer in layer.map { (name, $0) } }
        if plan.oldBubble != nil, let old = ringRoot?.sublayers?.first(where: { $0.name == "narration" }) { carried.append(("oldNarration", old)) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for (_, layer) in carried { layer.removeFromSuperlayer() }
        ringRoot?.removeAllAnimations(); ringRoot?.removeFromSuperlayer()
        let root = CALayer()
        root.frame = CGRect(origin: .zero, size: frame.size); root.isGeometryFlipped = true
        panel.contentView?.layer?.addSublayer(root)
        ringRoot = root; ringLabel = nil; ringTether = nil
        var layers: [String: CALayer] = ["root": root], specs: [String: RingLayer] = [:]
        for (name, layer) in carried {
            layer.name = name
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
                text.string = spec.text ?? ""; text.fontSize = spec.name == "narrationText" ? 11 : 8
                text.font = NSFont.systemFont(ofSize: text.fontSize)
                text.isWrapped = spec.name == "narrationText"; text.masksToBounds = true
                text.alignmentMode = spec.name == "narrationText" ? .left : .center; text.truncationMode = .end
                if spec.name == "narrationText" {
                    let paragraph = NSMutableParagraphStyle(); paragraph.minimumLineHeight = 14; paragraph.maximumLineHeight = 14
                    text.string = NSAttributedString(string: spec.text ?? "", attributes: [.font: NSFont.systemFont(ofSize: 11),
                        .foregroundColor: NSColor.white.withAlphaComponent(0.92), .paragraphStyle: paragraph])
                }
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
            layer.name = spec.name
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
                if name == "narration", track.duration == 0.09 {
                    animation.timingFunctions = Array(repeating: CAMediaTimingFunction(name: .easeOut), count: max(1, track.values.count - 1))
                }
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
        if let sprite = plan.sprite, !perch.legacyCallBlocked() {
            installSprite(sprite, ring: plan, root: root, frame: frame, begin: begin)
            if let pose = sprite.poses.last {
                let cell = sprite.character.frame.cell
                let box = CGRect(origin: sprite.origin(plan.at, pose.entry), size: CGSize(width: cell.width * pose.entry.scale, height: cell.height * pose.entry.scale))
                honestMood.install(in: root, box: box.offsetBy(dx: -frame.minX, dy: -frame.minY), reduced: sprite.reduced)
            }
        }
        CATransaction.commit()
        if !panel.isVisible { panel.orderFrontRegardless() }
        guard let pid = ringRuntime.session.pid, let window = ringRuntime.session.window,
            let clip = ringEnvironment.bounds(pid, window) else { return }
        // Wait until the moving art parks. A static hit box must never sit over a moving target or a drag route.
        let hit = pauseVisibility.placement(plan, clip: clip, sprite: cursorStyle == "sprite")
        pauseOverlay.show(hit.rect, sprite: hit.sprite, after: hit.after, capture: capture, control: pauseControl, mask: CursorPauseMask.make(plan),
            drag: cursorStyle == "sprite" ? badgeDrag : nil, began: { [weak self] in self?.beginBadgeArt() }, moved: { [weak self] in self?.moveBadgeArt($0) }, current: { [weak self] in
            self?.pauseVisibility.cleared == false && self?.captureHeld == false && cursorPauseCurrent(clip, handWindowBounds(window, pid: pid))
        })
    }

    func showCharacterBadge(_ rect: CGRect?, after delay: Double, pid: Int32, window: UInt32, current: @escaping () -> Bool) {
        guard !badgeDrag.active, !captureHeld, !pauseVisibility.cleared, let clip = handWindowBounds(window, pid: pid) else { return }
        pauseOverlay.show(rect, sprite: true, after: delay, capture: capture, control: pauseControl, drag: badgeDrag, owner: perch.panel,
            began: { [weak self] in self?.beginBadgeArt() }, moved: { [weak self] in self?.moveBadgeArt($0) }, current: { [weak self] in
                let expected = self?.perch.stageActive == true ? self?.perch.stage.seat?.world.base.window : self?.perch.runtime.seat?.frame
                return self?.captureHeld == false && self?.pauseVisibility.cleared == false && current() && cursorPauseCurrent(expected ?? clip, handWindowBounds(window, pid: pid))
            })
    }
    func receiveGeometry(_ proof: StageGeometryObservation) {
        // The old unscoped certificate is available to offline replay only.
        producer.failed = true; producerHide()
    }
    func admitPausedStage(_ incoming: RingEvent, ordinary: Bool = false) {
        guard ordinary || !producer.active || handKinds.contains(incoming.state) || incoming.state == "aim" else { return }
        guard perch.stage.options.enabled, let at = incoming.at,
            !(incoming.state == "handback" || incoming.state == "done" && !incoming.ok) else { return }
        let ev = PerchEvent(state: incoming.state, pid: incoming.pid, window: incoming.windowId, at: at, ok: incoming.ok,
            drop: nil, end: incoming.state == "drag" ? incoming.path.first : nil, windowRect: incoming.windowRect)
        let previous = perch.stage.event
        perch.stage.event = ev
        let world = admissionWorld.map { $0(ev) } ?? perch.stageEnvironment()
        perch.stage.event = previous ?? ev
        // Protection changes atomically. This admission path never installs a drawing or a ring timer.
        perch.performStage(perch.stage.admitPaused(ev, seq: incoming.seq, rect: incoming.rect, now: perch.now, world: world))
    }
    func placeLocalTarget(_ sequence: Int) -> Bool {
        guard perch.stageActive, !producer.active, !pauseControl.paused, !captureHeld, !badgeDrag.active,
            let incoming = pauseTarget, incoming.seq == sequence, let at = incoming.at,
            ["drag", "aim"].contains(incoming.state) else { hide(); return false }
        // Ring artwork may still be queued behind an older flourish. Admission and seating
        // use the resolved helper points immediately, before the local input is released.
        let ev = PerchEvent(state: incoming.state, pid: incoming.pid, window: incoming.windowId,
            at: incoming.state == "drag" ? incoming.path.last ?? at : at, ok: false, drop: nil,
            end: incoming.state == "drag" ? at : nil, windowRect: incoming.windowRect)
        let previous = perch.stage.event
        perch.stage.event = ev
        let world = admissionWorld.map { $0(ev) } ?? perch.stageEnvironment()
        perch.stage.event = previous
        perch.performStage(perch.stage.receive(ev, seq: sequence, rect: incoming.rect, now: perch.now,
            world: world, reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
        return perch.stage.shown
    }
    func receiveAct(_ act: HandAct) {
        _ = keepUnknownAppHidden(ringEvent(act))
        if producer.active { producer.failed = true; producerHide(); admitPausedStage(ringEvent(act)); return }
        if pauseControl.paused { admitPausedStage(ringEvent(act)); return }
        if badgeDrag.active || captureHeld { admitPausedStage(ringEvent(act)); return }
        pauseOverlay.hide(); pauseTarget = ringEvent(act)
        if cursorStyle == "glove" { schedule(act) } else { ringFrame(ringEvent(act), delay: act.delay) }
    }
    func receiveCursor(_ event: RingEvent) {
        pauseVisibility.status(event.state)
        if keepUnknownAppHidden(event) { return }
        if event.area != nil, perch.stageActive {
            if producer.active { producer.failed = true; producerHide(); return }
            let snapshot = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let ev: PerchEvent
            if event.wideEpoch != nil {
                let pids = event.pid > 0 ? Set([event.pid]) : stageWidePids(Set(event.wideName.map { [$0] } ?? []), snapshot: snapshot,
                    bundle: { NSRunningApplication(processIdentifier: $0)?.bundleIdentifier })
                let windows = stageWindows(snapshot, areaApps: pids)
                guard let admitted = perch.stage.beginWide(event, windows: windows, pids: pids) else {
                    if perch.stage.targetCapacity { perch.performStage(perch.stage.hide("target-capacity", immediate: true, at: perch.now)) }
                    return
                }
                ev = admitted
            } else { ev = stageAreaEvent(event, snapshot: snapshot) }
            perch.stage.event = ev; perch.stage.held = captureHeld; perch.stage.paused = pauseControl.paused
            perch.performStage(perch.stage.receive(ev, seq: event.seq, rect: nil, now: perch.now,
                world: perch.stageEnvironment(), reduced: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion))
            return
        }
        if event.state == "aim" { pauseOverlay.hide() }
        let terminal = event.state == "handback" || event.state == "done" && !event.ok
        if terminal, let identity = event.producer, identity != producer.identity {
            ringFrame(event, delay: 0); return
        }
        if producer.active && (event.state == "aim" || event.state == "handback" || event.state == "done" && !event.ok) {
            producer.failed = true; producerHide(); admitPausedStage(event); return
        }
        if !producer.active { perch.stage.completeTurn(state: event.state, ok: event.ok, now: perch.now) }
        if pauseControl.paused && event.state != "paused" && !producer.active { admitPausedStage(event); return }
        if badgeDrag.active || captureHeld { admitPausedStage(event); return }
        guard event.state != "paused" || pauseControl.paused else { return }
        if event.at != nil { pauseTarget = event }
        if cursorStyle != "glove" { ringFrame(event, delay: 0) }
    }
    // Drag art reuses a decoded, box-free paused cell. No capture, decode, timer or per-frame animation.
    func beginBadgeArt() {
        narrator.stop(); narrationWatch?.cancel(); narrationWatch = nil
        pending.values.forEach { $0.cancel() }; pending.removeAll()
        ringWake?.cancel(); ringWake = nil; fading?.cancel(); fading = nil
        perch.wake?.cancel(); perch.wake = nil; perch.pointerWake?.cancel(); perch.pointerWake = nil
        panel?.orderOut(nil); perch.panel?.orderOut(nil); perch.closeBubble()
        guard !captureHeld, let character = perch.loaded ?? ringRuntime.character,
            let entry = character.frame.table["paused"] ?? character.frame.table["idle"], let image = character.images[entry.sheet] else { return }
        let cell = character.frame.cell
        var height: CGFloat = cell.height * entry.scale
        if let draw = perch.stage.draw { height = draw.metrics.size.height }
        else if let metrics = perch.runtime.metrics { height = metrics.size.height }
        let scale = height / cell.height, size = CGSize(width: cell.width * scale, height: height)
        let panel = makeHandPanel(capture: "hidden"); badgeArt = panel
        panel.sharingType = .none
        panel.setFrame(appKitRect(CGRect(origin: .zero, size: size)), display: false)
        let layer = CALayer(); layer.frame = CGRect(origin: .zero, size: size); layer.contents = image
        layer.contentsRect = PerchPlan.rect(entry, entry.columns.first ?? 0, cell: cell)
        layer.contentsGravity = .resize; layer.magnificationFilter = .nearest
        panel.contentView?.layer?.isGeometryFlipped = true; panel.contentView?.layer?.addSublayer(layer)
    }
    func moveBadgeArt(_ point: CGPoint) {
        guard badgeDrag.active, !captureHeld, let panel = badgeArt else { return }
        let rect = CGRect(x: point.x - panel.frame.width / 2, y: point.y + 8, width: panel.frame.width, height: panel.frame.height)
        guard let snapshot = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { panel.orderOut(nil); return }
        var exclusions: [CGRect] = []
        let person = NSWorkspace.shared.frontmostApplication?.processIdentifier
        var foundPerson = false
        for row in snapshot {
            guard let raw = row[kCGWindowBounds as String] as? [String: Any], let box = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
            let pid = row[kCGWindowOwnerPID as String] as? Int32, level = row[kCGWindowLayer as String] as? Int
            if !foundPerson, pid == person, level == 0 { exclusions.append(box); foundPerson = true }
            if pid == getpid(), level == NSWindow.Level.modalPanel.rawValue { exclusions.append(box) }
        }
        if let target = pauseTarget {
            if let at = target.at { exclusions.append(stagePointRect(at, 48)) }
            if let box = target.rect { exclusions.append(box.insetBy(dx: -48, dy: -48)) }
        }
        guard cursorDragArtAllowed(rect, excluding: exclusions) else { panel.orderOut(nil); return }
        panel.setFrame(appKitRect(rect), display: false)
        if !panel.isVisible { panel.orderFrontRegardless() }
    }
    func endBadgeArt() { badgeArt?.orderOut(nil); badgeArt?.close(); badgeArt = nil }

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
        pauseOverlay.hide()
        ringRoot?.removeAllAnimations(); ringRoot?.removeFromSuperlayer(); ringRoot = nil; ringCursor = nil; ringLabel = nil; ringTether = nil
        panel?.orderOut(nil); panel?.close(); hand?.removeFromSuperlayer()
        panel = nil; hand = nil; glove = nil; dabs = nil; box = .null; fading = nil; shown = .rest
    }
    // --hand-demo X,Y,W,H plays every kind in turn inside that rect (global top-left points) for 30 seconds, then exits. It is
    // the live capture test's subject, and never reads stdin.
    func play(_ rect: CGRect) {
        if channelValidationOnly { return }
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

// BEGIN STAGE DUMP
extension StageDraw {
    func json(_ cell: CGSize, time: Double) -> [String: Any] {
        var out = pose.json(art?.cell ?? cell)
        let panel = stagePanelBounds(pose, metrics)
        out.merge(["effect": "stage", "time": time, "seq": seq, "height": seat.height, "rung": seat.rung, "fallback": fallback,
            "box": [seat.box.minX, seat.box.minY, seat.box.width, seat.box.height], "capture": panelPolicy.captureName, "hitAreas": panelPolicy.hitAreas, "dodgeMs": dodgeMs,
            "decisionReason": decisionReason as Any? ?? NSNull(),
            "legSpread": [metrics.legs.left, metrics.legs.right], "metricAnchor": [metrics.anchor.x, metrics.anchor.y],
            "metricSize": [metrics.size.width, metrics.size.height],
            "seat": ["kind": seat.kind, "window": seat.window], "seatLine": seatLine,
            "artSource": art?.source as Any? ?? NSNull(), "artCell": [art?.cell.width ?? cell.width, art?.cell.height ?? cell.height], "panel": [panel.minX, panel.minY, panel.width, panel.height]] as [String: Any]) { $1 }
        return out
    }
}
// BEGIN STAGE PANEL RECORDER
// A window-free substitute for an installed panel. Only the production release
// calls orderOut/close; the recorder reads the same lifetime as the real host.
final class StageDumpPanel: StagePanelWindow {
    private(set) var isVisible = true
    func orderOut(_ sender: Any?) { isVisible = false }
    func close() { isVisible = false }
}
func stageHideRow<Window>(_ lifetime: StagePanelLifetime<Window>, reason: String, duration: Double, time: Double) -> [String: Any] {
    ["effect": "stage-hide", "reason": reason, "duration": duration,
        "panelOnScreen": lifetime.panelOnScreen, "time": time, "animations": 0]
}
// END STAGE PANEL RECORDER
// Fixture metadata is separate from the nonce-bound hand protocol. No application, panel or layer exists.
// dumpLoadArt optionally exercises the sandboxed strip loader, with no drawing.
// dumpWorld: windows [{id,pid,frame,onScreen?,minimized?,fullScreen?}], displays [{frame,visible}], person (rect or null),
// pointer, inputAge, pointerAway, cards, missing? (true: no world at all, as when the window list can't be read; a null
// person is a windowless front app, which still seats). dumpActivity: locked/sleeping/call. dumpStageArt enables
// geometry ONLY, not art.
func stageDump(reduced: Bool, throughRing: Bool = false) {
    var ring = RingRuntime(theme: .seamPlus, seed: 1)
    struct Window { var id: UInt32, pid: Int32, rect: CGRect, visible: Bool, full: Bool; var owner: String = "" }
    var runtime = StageRuntime(), loadedArt: SpriteCharacter?, clock = 0.0, bound: String?, last = -1, buffer = Data()
    let panelLifetime = StagePanelLifetime<StageDumpPanel>()
    var panelFadeEnd: Double?, callMonitor: StageCallMonitor?
    var scheduledClock = false, wakeCounts: [String: Int] = [:]
    var panelGenerations = 0
    var replayImages: [Int: CGImage] = [:]
    var windows: [Window] = [], displays: [(CGRect, CGRect)] = [], person: CGRect?, pointer = CGPoint.zero, cards: [CGRect] = []
    var missing = false
    var age = 20.0, away = 10.0, sampled = 0.0, locked = false, sleeping = false, call = false, stageAvailable = true
    func tn(_ raw: Any?) -> Double? {
        guard let v = raw as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue.isFinite, abs(v.doubleValue) <= 1e12 else { return nil }
        return v.doubleValue
    }
    func n(_ raw: Any?) -> Double? {
        guard let v = raw as? NSNumber, CFGetTypeID(v) != CFBooleanGetTypeID(), v.doubleValue.isFinite, abs(v.doubleValue) <= 100000 else { return nil }; return v.doubleValue
    }
    func r(_ raw: Any?, empty: Bool = false) -> CGRect? {
        guard let a = raw as? [Any], a.count == 4, let x = n(a[0]), let y = n(a[1]), let w = n(a[2]), let h = n(a[3]) else { return nil }
        let rect = CGRect(x: x, y: y, width: w, height: h); return stageRectValid(rect) || empty && rect == .zero ? rect : nil
    }
    func world(_ supplied: PerchEvent? = nil) -> StageWorld? {
        guard !missing, let ev = supplied ?? runtime.event else { return nil }
        let index = windows.firstIndex(where: { $0.id == ev.window && $0.pid == ev.pid && $0.visible })
        let w = index.map { windows[$0] }
        let matchedDisplay = w.flatMap { win in displays.first(where: { $0.0.contains(CGPoint(x: win.rect.midX, y: win.rect.minY)) }) }
        guard let d = matchedDisplay ?? displays.first else { return nil }
        let above = index.map { windows[..<$0].filter { $0.visible }.map { $0.rect } } ?? windows.filter { $0.visible }.map { $0.rect }
        return StageWorld(base: PerchWorld(window: w?.rect ?? .zero, above: above, display: d.0, top: Double(d.1.minY), fullScreen: w?.full ?? false),
            usable: d.1, person: person, pointer: pointer, inputAge: age + clock - sampled, pointerAway: away + clock - sampled,
            windows: Dictionary(uniqueKeysWithValues: windows.filter { $0.visible }.map { (StageWindowKey(pid: $0.pid, window: $0.id), $0.rect) }),
            orderedWindows: windows.filter { $0.visible }.map { StageWindowKey(pid: $0.pid, window: $0.id) }, cards: cards, locked: locked, sleeping: sleeping, call: call || callMonitor?.isActive(clock) == true, stageAvailable: stageAvailable)
    }
    var ringEnvironment: RingEnvironment {
        RingEnvironment(bounds: { pid, id in windows.first { $0.pid == pid && $0.id == id && $0.visible }?.rect },
            reduced: { reduced }, secure: { false })
    }
    func ringEffects(_ effects: [(Double, RingEffect)]) {
        for (_, effect) in effects {
            if case let .draw(plan, _) = effect {
                let ev = perchEvent(plan)
                if !runtime.paused { runtime.event = ev }
                emit(runtime.receive(ev, seq: plan.seq, rect: plan.rect, now: clock, world: world(), reduced: reduced))
            }
        }
    }
    func write(_ object: [String: Any]) {
        let object = object.merging(["turnTargets": runtime.turnTargets.count, "shown": runtime.shown, "seq": runtime.seq, "time": clock,
            "hiddenReason": runtime.hiddenReason as Any? ?? NSNull(), "panelGenerations": panelGenerations]) { old, _ in old }
        guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
    func emit(_ effects: [StageEffect]) {
        let effects = stageCallApply(effects, runtime: &runtime, active: { callMonitor?.isActive(clock) == true }, at: clock)
        // The simulated clock completes a scheduled production fade. A later draw
        // cancels it, as the host's root-identity check does on the real queue.
        if let end = panelFadeEnd, clock >= end { panelLifetime.release(); panelFadeEnd = nil }
        for effect in effects {
            switch effect {
            case let .draw(plan):
                panelFadeEnd = nil
                if panelLifetime.panel == nil { panelLifetime.panel = StageDumpPanel(); panelGenerations += 1 }
                write(plan.json(runtime.base.frame?.cell ?? .zero, time: clock).merging(["panelOnScreen": panelLifetime.panelOnScreen]) { $1 })
            case let .hide(reason, duration):
                panelLifetime.hide(reason, duration: duration, release: { panelLifetime.release(); panelFadeEnd = nil }) { duration in
                    panelFadeEnd = clock + duration
                }
                write(stageHideRow(panelLifetime, reason: reason, duration: duration, time: clock))
            case .park: write(["effect": "stage-park", "time": clock, "animations": 0])
            case let .reseat(delta): write(["effect": "stage-reseat", "delta": [delta.x, delta.y], "time": clock])
            }
        }
    }
    while true {
        let bytes = FileHandle.standardInput.availableData
        if bytes.isEmpty {
            guard buffer.isEmpty else { exit(65) }
            write(["effect": "end", "time": clock, "shown": runtime.shown, "asleep": runtime.asleep, "animations": runtime.parkedAt == nil ? 0 : runtime.draw?.pose.keyPaths(runtime.base.frame?.cell ?? .zero).count ?? 0]); return
        }
        buffer.append(bytes); guard buffer.count <= 131072 else { exit(65) }
        while let end = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: end); buffer.removeSubrange(...end)
            guard line.count <= 32768, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { exit(65) }
            if Set(data.keys) == ["dumpTrace"] {
                guard data["dumpTrace"] as? Bool == true else { exit(65) }
                runtime.trace = StageTrace(); continue
            }
            if Set(data.keys) == ["dumpTraceRead"] {
                guard data["dumpTraceRead"] as? Bool == true, let trace = runtime.trace else { exit(65) }
                write(trace.json.merging(["effect": "stage-trace"]) { $1 }); continue
            }
            if Set(data.keys) == ["dumpTransaction"] {
                guard let input = data["dumpTransaction"] as? [String: Any], let op = input["op"] as? String else { exit(65) }
                func windowMap(_ raw: Any?) -> [StageWindowKey: CGRect]? {
                    guard let list = raw as? [[String: Any]], list.count <= 128 else { return nil }
                    var out: [StageWindowKey: CGRect] = [:]
                    for item in list {
                        guard let pid = tn(item["pid"]), (1...2147483647).contains(pid), pid.rounded() == pid,
                            let id = tn(item["id"]), (1...4294967295).contains(id), id.rounded() == id, let rect = r(item["frame"]) else { return nil }
                        let key = StageWindowKey(pid: Int32(pid), window: UInt32(id))
                        guard out[key] == nil else { return nil }; out[key] = rect
                    }
                    return out
                }
                if op == "windows" {
                    guard let windows = windowMap(input["windows"]) else { exit(65) }
                    runtime.observeWindows(windows); continue
                }
                guard let at = tn(input["now"]), let reduced = input["reduced"] as? Bool,
                    let flags = input["flags"] as? [String: Any], let provider = input["provider"] as? Bool,
                    let art = input["art"] as? [[String: Any]], art.count <= 8 else { exit(65) }
                clock = at
                runtime.carrying = flags["carrying"] as? Bool == true; runtime.carryUntil = tn(flags["carryUntil"]) ?? 0
                runtime.held = flags["held"] as? Bool == true; runtime.paused = flags["paused"] as? Bool == true
                runtime.locked = flags["locked"] as? Bool == true; runtime.displaySleeping = flags["sleeping"] as? Bool == true
                runtime.badgeApproach = flags["badgeApproach"] as? Bool == true; runtime.stageArt = flags["stageArt"] as? Bool == true
                var exactWorld: StageWorld?
                if let w = input["world"] as? [String: Any] {
                    guard let win = r(w["window"], empty: true), let display = r(w["display"]), let usable = r(w["usable"]),
                        let above = w["above"] as? [Any], above.count <= 128, let cards = w["cards"] as? [Any], cards.count <= 128,
                        let pointer = w["pointer"] as? [Double], pointer.count == 2, pointer.allSatisfy({ $0.isFinite }),
                        let inputAge = tn(w["inputAge"]), let pointerAway = tn(w["pointerAway"]), let top = n(w["top"]) else { exit(65) }
                    let asRects = above.compactMap { r($0) }, cs = cards.compactMap { r($0) }
                    guard asRects.count == above.count, cs.count == cards.count else { exit(65) }
                    exactWorld = StageWorld(base: PerchWorld(window: win, above: asRects, display: display, top: top, fullScreen: w["fullScreen"] as? Bool == true),
                        usable: usable, person: r(w["person"]), pointer: CGPoint(x: pointer[0], y: pointer[1]), inputAge: inputAge, pointerAway: pointerAway,
                        windows: windowMap(w["windows"]), orderedWindows: (w["orderedWindows"] as? [[String: Int]] ?? []).compactMap {
                            guard let pid = $0["pid"], let id = $0["id"], pid > 0, pid <= Int(Int32.max), id > 0, id <= Int(UInt32.max) else { return nil }
                            return StageWindowKey(pid: Int32(pid), window: UInt32(id))
                        }, cards: cs, locked: w["locked"] as? Bool == true, sleeping: w["sleeping"] as? Bool == true,
                        call: w["call"] as? Bool == true, displayID: w["displayID"] as? String, stageAvailable: w["stageAvailable"] as? Bool == true)
                } else if !(input["world"] is NSNull) { exit(65) }
                func traceEntry(_ raw: [String: Any], _ cell: CGSize) -> SpriteEntry? {
                    guard let sheet = raw["sheet"] as? String, sheet.utf8.count <= 4096,
                        let row = raw["row"] as? Int, (0...63).contains(row), let columns = raw["frames"] as? [Int], (1...8).contains(columns.count),
                        columns.allSatisfy({ (0...7).contains($0) }), let ms = raw["ms"] as? [Double], ms.count == columns.count,
                        ms.allSatisfy({ $0.isFinite && (20...2000).contains($0) }), ms.reduce(0, +) <= 8000,
                        let loop = raw["loop"] as? Bool, let flip = raw["flip"] as? Bool,
                        let hotspot = raw["hotspot"] as? [Double], hotspot.count == 2, hotspot.allSatisfy({ $0.isFinite && abs($0) <= 2048 }),
                        let size = raw["size"] as? [Double], size.count == 2, size.allSatisfy({ $0.isFinite && (1...16384).contains($0) }),
                        size[0] >= cell.width * Double((columns.max() ?? 0) + 1), size[1] >= cell.height * Double(row + 1),
                        let scale = tn(raw["scale"]), (0.25...2).contains(scale) else { return nil }
                    return SpriteEntry(sheet: sheet, row: row, columns: columns, ms: ms, loop: loop, flip: flip,
                        hotspot: CGPoint(x: hotspot[0], y: hotspot[1]), size: CGSize(width: size[0], height: size[1]), scale: scale, then: nil)
                }
                var artIndex = 0
                runtime.artProvider = provider ? { state in
                    guard artIndex < art.count, art[artIndex]["state"] as? String == state else { exit(65) }
                    let raw = art[artIndex]["pose"]; artIndex += 1
                    if raw is NSNull { return nil }
                    guard let p = raw as? [String: Any], let cell = p["cell"] as? [Double], cell.count == 2,
                        cell.allSatisfy({ $0.isFinite && (1...1024).contains($0) }), let anchor = p["anchor"] as? [Double], anchor.count == 2,
                        anchor.allSatisfy({ $0.isFinite && abs($0) <= 1024 }), let entryRaw = p["entry"] as? [String: Any],
                        let entry = traceEntry(entryRaw, CGSize(width: cell[0], height: cell[1])),
                        let source = p["source"] as? String, source.utf8.count <= 64, let imageID = p["image"] as? Int, (0..<4096).contains(imageID),
                        let data = CGDataProvider(data: Data([0, 0, 0, 0]) as CFData),
                        let image = CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                            provider: data, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { exit(65) }
                    if replayImages[imageID] == nil { replayImages[imageID] = image }
                    return SpriteStagePose(image: replayImages[imageID]!, entry: entry, cell: CGSize(width: cell[0], height: cell[1]), anchor: CGPoint(x: anchor[0], y: anchor[1]),
                        filter: p["filter"] as? String ?? "linear", source: source, medium: p["medium"] as? Bool == true, pending: p["pending"] as? Bool == true)
                } : nil
                switch op {
                case "receive", "admission":
                    guard let e = input["event"] as? [String: Any], let state = e["state"] as? String, state.utf8.count <= 32,
                        let pid = tn(e["pid"]), (1...2147483647).contains(pid), let id = tn(e["window"]), (1...4294967295).contains(id),
                        let xy = e["at"] as? [Double], xy.count == 2, xy.allSatisfy({ $0.isFinite }), let seq = tn(input["seq"]) else { exit(65) }
                    let end = e["end"] as? [Double]
                    guard end == nil || end!.count == 2 && end!.allSatisfy({ $0.isFinite }) else { exit(65) }
                    let event = PerchEvent(state: state, pid: Int32(pid), window: UInt32(id), at: CGPoint(x: xy[0], y: xy[1]), ok: e["ok"] as? Bool == true,
                        drop: tn(e["drop"]), end: end.map { CGPoint(x: $0[0], y: $0[1]) }, windowRect: r(e["windowRect"]), area: e["area"] as? String, wideReason: e["wideReason"] as? String)
                    if !runtime.paused || runtime.event == nil { runtime.event = event }
                    if op == "admission" { emit(runtime.admitPaused(event, seq: Int(seq), rect: r(input["rect"]), now: at, world: exactWorld)) }
                    else { emit(runtime.receive(event, seq: Int(seq), rect: r(input["rect"]), now: at, world: exactWorld, reduced: reduced)) }
                case "geometry":
                    guard let raw = input["geometry"] as? [String: Any], let proof = StageGeometryObservation.parse(raw) else { exit(65) }
                    emit(runtime.certifyGeometry(proof, now: at, world: exactWorld, reduced: reduced))
                case "observe": emit(runtime.observe(at, world: exactWorld, reduced: reduced))
                case "pause":
                    guard let value = input["value"] as? Bool else { exit(65) }
                    emit(runtime.setPaused(value, now: at, world: exactWorld, reduced: reduced))
                case "pointer":
                    guard let entered = tn(input["enteredAt"]) else { exit(65) }
                    emit(runtime.pointerChanged(at, enteredAt: entered, world: exactWorld, reduced: reduced))
                case "complete":
                    guard let state = input["state"] as? String, let ok = input["ok"] as? Bool else { exit(65) }
                    runtime.completeTurn(state: state, ok: ok, now: at)
                case "hide":
                    guard let reason = input["reason"] as? String, let immediate = input["immediate"] as? Bool else { exit(65) }
                    emit(runtime.hide(reason, immediate: immediate, at: at))
                    if reason == "hide" { runtime.event = nil }
                default: exit(65)
                }
                guard artIndex == art.count else { exit(65) }; continue
            }
            if Set(data.keys) == ["dumpSyntheticArt"] {
                let config = data["dumpSyntheticArt"] as? [String: Any]
                guard config == nil || Set(config!.keys) == ["mode", "pending"],
                    let mode = (data["dumpSyntheticArt"] as? String) ?? config?["mode"] as? String, ["ready", "pending", "failed"].contains(mode),
                    let pending = config == nil ? [] : config?["pending"] as? [String], pending.count <= 21,
                    pending.allSatisfy({ spriteStageFallbacks[$0] != nil }),
                    let frame = runtime.base.frame,
                    let provider = CGDataProvider(data: Data([0, 0, 0, 0]) as CFData),
                    let image = CGImage(width: 1, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else { exit(65) }
                runtime.artProvider = { state in
                    guard let entry = frame.stage?[state] else { return nil }
                    let ready = mode == "ready" && !pending.contains(state)
                    return SpriteStagePose(image: image, entry: ready ? entry.art : entry.fallbackArt,
                        cell: ready ? entry.cell : frame.cell,
                        anchor: ready ? entry.anchor : frame.perch!.anchor,
                        filter: entry.filter, source: ready ? state : entry.fallback,
                        medium: !ready, pending: mode == "pending" || pending.contains(state))
                }
                continue
            }
            if Set(data.keys) == ["dumpLoadArt"] {
                guard data["dumpLoadArt"] as? Bool == true, let frame = runtime.base.frame else { exit(65) }
                let result = SpriteCharacter.check(frame)
                guard let character = result.character else { write(["effect": "stage-load", "reason": result.reason ?? "unknown"]); exit(65) }
                loadedArt = character
                runtime.artProvider = { state in character.stage.select(state, images: character.images) }
                write(["effect": "stage-load", "loaded": true]); continue
            }
            if Set(data.keys) == ["dumpAwaitArt"] {
                guard data["dumpAwaitArt"] as? Bool == true, let character = loadedArt else { exit(65) }
                SpriteLoader.queue.sync {}
                write(character.stage.counters.merging(["effect": "stage-ready"]) { $1 }); continue
            }
            if Set(data.keys) == ["dumpPanelCheck"] {
                guard let values = data["dumpPanelCheck"] as? [String: Any], let target = r(values["target"]), let actual = r(values["actual"]) else { exit(65) }
                write(["effect": "panel-check", "accepted": stagePanelFrameAccepted(target: target, actual: actual)]); continue
            }
            if Set(data.keys) == ["dumpStats"] {
                guard data["dumpStats"] as? Bool == true else { exit(65) }
                write(["effect": "stage-stats", "poll": runtime.poll as Any? ?? NSNull(), "wakeCounts": wakeCounts, "forbiddenBuilds": runtime.forbiddenBuilds,
                    "wideWindows": runtime.wideWindows.sorted { $0.pid == $1.pid ? $0.window < $1.window : $0.pid < $1.pid }.map { ["pid": $0.pid, "id": $0.window] },
                    "wideRecords": stageTraceWindows(runtime.wideRecords),
                    "compactedWindows": runtime.compactedWindows.map { ["pid": $0.pid, "id": $0.window] },
                    "worldAvailable": world() != nil,
                    "forbidden": world().map { runtime.forbidden($0).map(stageTraceRect) } ?? runtime.activeTargets.map(stageTraceRect),
                    "turnTargets": runtime.turnTargets.count, "activeTargets": runtime.activeTargets.count, "targetCapacity": runtime.targetCapacity, "targetUnmapped": runtime.targetUnmapped,
                    "contributors": runtime.turnTargets.reduce(0, { $0 + $1.contributors.count }), "windowRecords": runtime.windowBook.current.count,
                    "planBegan": runtime.planBegan, "presented": runtime.shown ? runtime.draw.map { $0.json(runtime.base.frame?.cell ?? .zero, time: clock) } as Any? ?? NSNull() : NSNull(),
                    "hideReasonCounts": runtime.hideReasonCounts, "maxWindowBoundsDifferencePt": runtime.maxWindowBoundsDifferencePt as Any? ?? NSNull(),
                    "targetBindings": runtime.turnTargets.map { ["pid": $0.key.pid, "window": $0.key.window, "generation": $0.epoch.generation,
                        "contentGeneration": $0.epoch.content, "outside": $0.outside,
                        "contributors": $0.contributors.map { ["seq": $0.seq, "state": $0.state, "contentGeneration": $0.content] as [String: Any] },
                        "windowRect": [$0.epoch.bounds.minX, $0.epoch.bounds.minY, $0.epoch.bounds.width, $0.epoch.bounds.height],
                        "rect": [$0.box.minX, $0.box.minY, $0.box.width, $0.box.height]] as [String: Any] }, "pointerActive": runtime.pointerActive,
                    "hiddenReason": runtime.hiddenReason as Any? ?? NSNull()]); continue
            }
            if Set(data.keys) == ["dumpMeasureTicks"] {
                guard let count = n(data["dumpMeasureTicks"]), count.rounded() == count, (1...10000).contains(count) else { exit(65) }
                let before = runtime.forbiddenBuilds, began = CACurrentMediaTime()
                for _ in 0..<Int(count) { _ = runtime.observe(clock, world: world(), reduced: reduced) }
                write(["effect": "stage-cost", "ticks": Int(count), "msPerTick": (CACurrentMediaTime() - began) * 1000 / count,
                    "forbiddenBuilds": runtime.forbiddenBuilds - before, "turnTargets": runtime.turnTargets.count]); continue
            }
            if Set(data.keys) == ["dumpPointer"] {
                guard let p = data["dumpPointer"] as? [String: Any], let xy = p["at"] as? [Any], xy.count == 2,
                    let x = n(xy[0]), let y = n(xy[1]), let delay = n(p["delayMs"]), (0...500).contains(delay) else { exit(65) }
                let entered = clock, began = CACurrentMediaTime()
                // Exercise actual run-loop delivery after idle, without creating an app or a window.
                RunLoop.current.run(until: Date(timeIntervalSinceNow: delay / 1000))
                clock += CACurrentMediaTime() - began; pointer = CGPoint(x: x, y: y); age = 0; away = 0; sampled = clock
                emit(runtime.pointerChanged(clock, enteredAt: entered, world: world(), reduced: reduced)); continue
            }
            if Set(data.keys) == ["dumpSchedule"] {
                guard let value = data["dumpSchedule"] as? Bool else { exit(65) }; scheduledClock = value; continue
            }
            if Set(data.keys) == ["dumpClock"] {
                guard let next = n(data["dumpClock"]), next >= clock else { exit(65) }
                if scheduledClock {
                    while let wake = runtime.nextWake(clock), wake.at <= next {
                        clock = wake.at; wakeCounts[wake.source, default: 0] += 1
                        emit(runtime.observe(clock, world: world(), reduced: reduced))
                    }
                }
                clock = next
                if throughRing { ringEffects(ring.advance(to: clock, ringEnvironment)) }
                emit(runtime.observe(clock, world: world(), reduced: reduced)); continue
            }
            if Set(data.keys) == ["dumpStageArt"] {
                guard let v = data["dumpStageArt"] as? Bool else { exit(65) }; runtime.stageArt = v; continue
            }
            if Set(data.keys) == ["dumpStageAvailable"] {
                guard let v = data["dumpStageAvailable"] as? Bool else { exit(65) }; stageAvailable = v; continue
            }
            if Set(data.keys) == ["dumpReset"] {
                guard data["dumpReset"] as? Bool == true else { exit(65) }
                panelLifetime.release(); panelFadeEnd = nil
                let frame = runtime.base.frame, art = runtime.stageArt; runtime.load(frame); runtime.stageArt = art; continue
            }
            if Set(data.keys) == ["dumpPaused"] {
                guard let p = data["dumpPaused"] as? Bool else { exit(65) }
                emit(runtime.setPaused(p, now: clock, world: world(), reduced: reduced)); continue
            }
            // Opt-in microphone fixtures share production completion logic. They never query audio.
            if Set(data.keys) == ["dumpCallSample"] {
                guard let state = data["dumpCallSample"] as? String,
                    ["pending", "quiet", "input-active", "timeout", "unavailable"].contains(state) else { exit(65) }
                if callMonitor == nil { callMonitor = StageCallMonitor() }
                if state == "pending" { callMonitor!.pending = true; callMonitor!.requested = clock }
                else { callMonitor!.complete((state == "quiet", state, state == "input-active" ? "microphone input active" : state), at: clock, elapsedMs: 0) }
                emit(runtime.observe(clock, world: world(), reduced: reduced))
                write(["effect": "call-sample", "callMonitor": callMonitor!.snapshot(clock)]); continue
            }
            if Set(data.keys) == ["dumpActivity"] {
                guard let a = data["dumpActivity"] as? [String: Any], Set(a.keys).isSubset(of: ["locked", "sleeping", "call"]), !a.isEmpty else { exit(65) }
                for (key, raw) in a {
                    guard let v = raw as? NSNumber, CFGetTypeID(v) == CFBooleanGetTypeID() else { exit(65) }
                    if key == "locked" { locked = v.boolValue; runtime.locked = locked }; if key == "sleeping" { sleeping = v.boolValue; runtime.displaySleeping = sleeping }; if key == "call" { call = v.boolValue }
                }
                emit(runtime.observe(clock, world: world(), reduced: reduced)); continue
            }
            if Set(data.keys) == ["dumpWindowMetadata"] {
                guard let census = data["dumpWindowMetadata"] as? [String: Any], Set(census.keys) == ["windows", "appPids"],
                    let windows = census["windows"] as? [[String: Any]], windows.count <= 128,
                    let pids = census["appPids"] as? [Int32], pids.count <= 128, pids.allSatisfy({ $0 > 0 }) else { exit(65) }
                let anchors: [[String: Any]] = pids.map { pid in
                    let event = RingEvent(seq: 0, state: "thinking", pid: pid, windowId: 0, at: nil, rect: nil, label: nil, say: nil, area: "app")
                    let anchor = stageAreaEvent(event, snapshot: windows)
                    return ["pid": pid, "id": anchor.window, "area": "app", "at": [anchor.at.x, anchor.at.y]]
                }
                write(["effect": "stage-census", "windows": stageTraceWindows(stageWindows(windows, areaApps: Set(pids))), "areaAnchors": anchors,
                    "dropWindows": stageTraceWindows(stageWindows(windows)), "windowlessAbove": stageWindowlessAbove(windows, own: 0).map(stageTraceRect)]); continue
            }
            if Set(data.keys) == ["dumpWorld"] {
                guard let w = data["dumpWorld"] as? [String: Any], let list = w["windows"] as? [[String: Any]], list.count <= 129,
                    let ds = w["displays"] as? [[String: Any]], (1...16).contains(ds.count),
                    let xy = w["pointer"] as? [Any], xy.count == 2, let x = n(xy[0]), let y = n(xy[1]),
                    let input = n(w["inputAge"]), input >= 0, let pointerAge = n(w["pointerAway"]), pointerAge >= 0,
                    let cs = w["cards"] as? [Any], cs.count <= 128 else { exit(65) }
                windows = []; displays = []; cards = []
                for item in list {
                    guard let id = n(item["id"]), id.rounded() == id, (1...100000).contains(id),
                        let pid = n(item["pid"]), pid.rounded() == pid, (1...100000).contains(pid), let frame = r(item["frame"]) else { exit(65) }
                    windows.append(Window(id: UInt32(id), pid: Int32(pid), rect: frame, visible: item["onScreen"] as? Bool != false && item["minimized"] as? Bool != true, full: item["fullScreen"] as? Bool == true, owner: item["owner"] as? String ?? ""))
                }
                guard Set(windows.map { $0.id }).count == windows.count else { exit(65) }
                let namedPids = Set(windows.filter { w in runtime.wideNames.contains(where: { $0.caseInsensitiveCompare(w.owner) == .orderedSame }) }.map { $0.pid })
                if runtime.wideApps.union(namedPids).count > 128 { runtime.targetCapacity = true }
                else { runtime.wideApps.formUnion(namedPids) }
                runtime.observeWindows(Dictionary(uniqueKeysWithValues: windows.filter { $0.visible }.map { (StageWindowKey(pid: $0.pid, window: $0.id), $0.rect) }))
                if let ev = runtime.event, !windows.contains(where: { $0.pid == ev.pid && $0.id == ev.window && $0.visible }),
                    let w = windows.first(where: { $0.visible && ($0.pid == ev.pid || ev.pid == 0 && runtime.wideApps.contains($0.pid)) }) {
                    runtime.wideApps.insert(w.pid)
                    for candidate in windows where candidate.pid == w.pid { runtime.invalidateGeometry(StageWindowKey(pid: candidate.pid, window: candidate.id)) }
                    runtime.event = PerchEvent(state: ev.state, pid: w.pid, window: w.id, at: CGPoint(x: w.rect.midX, y: w.rect.midY),
                        ok: ev.ok, drop: nil, end: nil, area: "app", wideReason: ev.wideReason)
                }
                for d in ds { guard let frame = r(d["frame"]), let visible = r(d["visible"]), frame.contains(visible) else { exit(65) }; displays.append((frame, visible)) }
                for c in cs { guard let rect = r(c) else { exit(65) }; cards.append(rect) }
                if w["person"] is NSNull { person = nil } else { guard let rect = r(w["person"]) else { exit(65) }; person = rect }
                if let m = w["missing"] { guard let flag = m as? Bool, CFGetTypeID(m as CFTypeRef) == CFBooleanGetTypeID() else { exit(65) }; missing = flag } else { missing = false }
                pointer = CGPoint(x: x, y: y); age = input; away = pointerAge; sampled = clock
                if runtime.event != nil { emit(runtime.observe(clock, world: world(), reduced: reduced)) }; continue
            }
            if data["hand"] as? String == "stage-geometry" {
                guard let (nonce, seq, proof) = stageGeometryFrame(data), bound == nil || bound == nonce, handSequenceFresh(seq, after: last) else { exit(65) }
                bound = nonce; last = seq
                let ev = PerchEvent(state: "thinking", pid: proof.key.pid, window: proof.key.window,
                    at: CGPoint(x: proof.bounds.midX, y: proof.bounds.midY), ok: false, drop: nil, end: nil, windowRect: proof.bounds)
                emit(runtime.certifyGeometry(proof, now: clock, world: world(ev), reduced: reduced)); continue
            }
            guard let hand = handFrame(data), let nonce = data["nonce"] as? String, bound == nil || bound == nonce else { exit(65) }; bound = nonce
            switch hand {
            case let .character(_, f):
                guard handSequenceFresh(f.seq, after: last) else { exit(65) }; last = f.seq
                panelLifetime.release(); panelFadeEnd = nil; runtime.load(f)
            case let .aim(_, ev), let .status(_, ev):
                if ev.area != nil {
                    guard handSequenceFresh(ev.seq, after: last) else { exit(65) }; last = ev.seq
                    let event: PerchEvent
                    let observed = Dictionary(uniqueKeysWithValues: windows.filter { $0.visible }.map { (StageWindowKey(pid: $0.pid, window: $0.id), $0.rect) })
                    if ev.wideEpoch != nil {
                        let pids = ev.pid > 0 ? Set([ev.pid]) : Set(windows.filter { $0.owner.caseInsensitiveCompare(ev.wideName ?? "") == .orderedSame }.map { $0.pid })
                        guard let admitted = runtime.beginWide(ev, windows: observed, pids: pids) else {
                            if runtime.targetCapacity { emit(runtime.hide("target-capacity", immediate: true, at: clock)) }
                            continue
                        }
                        event = admitted
                    } else { event = stageAreaEvent(ev, windows: observed) }
                    runtime.event = event
                    emit(runtime.receive(event, seq: ev.seq, rect: nil, now: clock, world: world(), reduced: reduced)); continue
                }
                guard handSequenceFresh(ev.seq, after: last) else { exit(65) }; last = ev.seq
                if ev.at == nil && (ev.state == "handback" || ev.state == "done" && !ev.ok) {
                    runtime.completeTurn(state: ev.state, ok: ev.ok, now: clock); continue
                }
                guard let at = ev.at else { exit(65) }
                if throughRing { runtime.completeTurn(state: ev.state, ok: ev.ok, now: clock); ringEffects(ring.receive(ev, delay: 0, now: clock, ringEnvironment)); continue }
                let event = PerchEvent(state: ev.state, pid: ev.pid, window: ev.windowId, at: at, ok: ev.ok, drop: nil, end: nil, windowRect: ev.windowRect)
                // Set the identity before looking up its metadata, exactly as the host does for a new window.
                if !runtime.paused { runtime.event = event }
                emit(runtime.receive(event, seq: ev.seq, rect: ev.rect, now: clock, world: world(), reduced: reduced))
            case let .act(_, act):
                guard handSequenceFresh(act.seq, after: last) else { exit(65) }; last = act.seq
                if throughRing { ringEffects(ring.receive(ringEvent(act), delay: act.delay, now: clock, ringEnvironment)); continue }
                let event = PerchEvent(state: act.kind, pid: act.pid, window: act.windowId, at: act.at, ok: false, drop: nil, end: act.kind == "drag" ? act.path.first : nil, windowRect: act.windowRect)
                if !runtime.paused { runtime.event = event }
                emit(runtime.receive(event, seq: act.seq, rect: act.rect, now: clock, world: world(), reduced: reduced))
            case .clear: runtime.held = true; emit(runtime.hide("clear", immediate: true, at: clock))
            case .hide: emit(runtime.hide("hide", at: clock)); runtime.event = nil
            default: exit(65)
            }
        }
    }
}
// END STAGE DUMP

// BEGIN PERCH DUMP
// --perch-dump [--reduce-motion] [--seed=N]: PerchRuntime and the ring's RingRuntime on a simulated clock, as the host drives
// them, with window lists the input injects. It builds no application, panel, window or layer and decodes nothing: plans
// come from the character frame's data. Lines: hand frames; {"dumpClock": s}; {"dumpWorld": {"windows": [{"id", "pid",
// "frame": [x, y, w, h], "fullScreen"?}] front to back, "displays"?: [{"frame", "top"}]}} (also a window check at that
// moment); {"dumpNarration": s} (a narration bubble for s seconds); {"dumpPaused": bool}; {"dumpClick": "hardware" |
// "synthetic" | "keyboard" | "old"} (a click on the bubble through the person-input rule); {"dumpLegs": [left, right]} (a
// leg spread in points); {"dumpDecode": true} (decodes the character as the host does and measures its legs). Clear
// frames, menu frames (narration) and statuses drive C1's clear rule and C2's bubble as in the host. With perch off,
// lines run in trail mode by the sprite's box.
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
func perchDump(reduced: Bool, seed: UInt64, callChecks: Bool = false) {
    var buffer = Data(), bound: String?, last = -1, clock = 0.0, enabled = true
    var ring = RingRuntime(theme: .seamPlus, seed: seed), perch = PerchRuntime(), pauseVisibility = CursorPauseVisibility()
    let monitor = StageCallMonitor()
    var callEvent: PerchEvent?, hideReason: String?, installCount = 0, quietRechecks = 0, panelVisible = false
    var wakeCounts: [String: Int] = [:]
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
            case let .draw(plan):
                installCount += 1; hideReason = nil; panelVisible = true
                write(plan.json(cell).merging(["effect": "perch", "time": time]) { $1 })
            case let .reseat(delta): write(["effect": "perch-reseat", "delta": [delta.x, delta.y], "time": time])
            case let .hide(reason, duration):
                hideReason = reason; panelVisible = false
                write(["effect": "perch-hide", "reason": reason, "duration": duration, "time": time])
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
    func observeCall() {
        guard let event = callEvent else { return }
        if monitor.isActive(clock) {
            if perch.shown { emit(perch.hide(clock, "call")) }
        } else if !perch.shown && hideReason == "call" { emit(perch.receive(event, now: clock, env: env)) }
        else { emit(perch.observeCall(now: clock, env: env, visible: panelVisible)) }
    }
    func ringEmit(_ effects: [(Double, RingEffect)]) {
        for (time, effect) in effects {
            guard case let .draw(plan, _) = effect else { if case .hide = effect { write(["effect": "ring-hide", "time": time]) }; continue }
            write(["effect": "ring", "state": plan.state, "at": [plan.at.x, plan.at.y], "time": time, "narration": plan.bubble != nil])
            if callChecks {
                callEvent = perchEvent(plan)
                if monitor.isActive(clock) { emit(perch.hide(clock, "call")); continue }
            }
            perch.book.cleared = pauseVisibility.cleared
            emit(perch.narrationDrawn(plan.bubble == nil ? nil : perchNarrationSpan(plan), now: time))
            if enabled {
                if callChecks { emit(perch.receiveVisible(perchEvent(plan), now: time, env: env, visible: panelVisible)) }
                else { emit(perch.receive(perchEvent(plan), now: time, env: env)) }
            }
            else if let frame = perch.frame, let w = world(plan.pid, plan.window), let box = perchTrailBox(plan.at, frame: frame, clip: w.window) {
                emit(perch.trail(perchEvent(plan), box: box, world: w, now: time, env: env))
            }
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
                if callChecks {
                    // The renderer's earliest-deadline policy, on a simulated clock.
                    // Metadata reads and microphone completions are supplied by stdin, never queried from the Mac.
                    while true {
                        guard let due = perch.nextWake(clock, callHidden: hideReason == "call"), due.at <= value else { break }
                        clock = due.at
                        wakeCounts[due.source, default: 0] += 1
                        observeCall()
                    }
                    clock = value; continue
                }
                clock = value
                ringEmit(ring.advance(to: clock, ringEnv)); emit(perch.advance(to: clock, env: env))
                continue
            }
            if callChecks && Set(data.keys) == ["dumpCallSample"] {
                guard let state = data["dumpCallSample"] as? String,
                    ["quiet", "input-active", "pending", "timeout", "unavailable"].contains(state) else { exit(65) }
                if state == "pending" { monitor.pending = true; monitor.requested = clock }
                else {
                    if state == "quiet" { quietRechecks += 1 }
                    monitor.complete((state == "quiet", state, state), at: clock, elapsedMs: 0)
                }
                observeCall(); continue
            }
            if callChecks && Set(data.keys) == ["dumpStats"] {
                guard data["dumpStats"] as? Bool == true else { exit(65) }
                write(["effect": "legacy-stats", "time": clock, "shown": perch.shown, "installCount": installCount,
                    "quietRechecks": quietRechecks, "callMonitor": monitor.snapshot(clock), "wakeCounts": wakeCounts, "panelVisible": panelVisible,
                    "poll": perch.poll as Any? ?? NSNull(), "timers": perch.timers.map { ["at": $0.at, "action": $0.action] },
                    "windowsCreated": 0, "captures": 0]); continue
            }
            if callChecks && Set(data.keys) == ["dumpPanelVisible"] {
                guard let visible = data["dumpPanelVisible"] as? Bool else { exit(65) }; panelVisible = visible; continue
            }
            if Set(data.keys) == ["dumpWorld"] {
                guard let w = data["dumpWorld"] as? [String: Any], let list = w["windows"] as? [[String: Any]] else { exit(65) }
                windows = []
                for item in list {
                    guard let id = number(item["id"]), let pid = number(item["pid"]), let frame = rect(item["frame"]) else { exit(65) }
                    windows.append((UInt32(id), Int32(pid), frame, item["fullScreen"] as? Bool ?? false))
                }
                if let list = w["displays"] as? [[String: Any]] {
                    displays = list.compactMap { d in rect(d["frame"]).flatMap { f in
                        (number(d["top"]) ?? (callChecks ? rect(d["visible"]).map { Double($0.minY) } : nil)).map { (f, $0) }
                    } }
                    guard displays.count == list.count, !displays.isEmpty else { exit(65) }
                }
                if callChecks { observeCall() } else { emit(perch.observe(clock, env: env)) }; continue
            }
            if Set(data.keys) == ["dumpNarration"] { guard let s = number(data["dumpNarration"]) else { exit(65) }; emit(perch.narration(until: clock + s, now: clock)); continue }
            if Set(data.keys) == ["dumpLegs"] {
                guard let a = data["dumpLegs"] as? [Any], a.count == 2, let l = number(a[0]), let r = number(a[1]) else { exit(65) }
                perch.legs = (l, r); continue
            }
            if Set(data.keys) == ["dumpDecode"] {
                guard let frame = perch.frame else { exit(65) }
                let result = SpriteCharacter.check(frame), legs = result.character.flatMap { perchLegs($0) }
                let seated = result.character.flatMap { perchLegs($0, states: ["perch"]) }
                perch.legs = legs
                write(["effect": "legs", "loaded": result.character != nil, "reason": result.reason as Any? ?? NSNull(),
                    "legs": legs.map { [$0.0, $0.1] } as Any? ?? NSNull(), "seated": seated.map { [$0.0, $0.1] } as Any? ?? NSNull(), "time": clock]); continue
            }
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
            case .edge: continue
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
            case .clear:
                // C1's clear: the host hides everything, and no click panel shows until the action's done or idle.
                pauseVisibility.clear(); ringEmit(ring.hide(clock)); emit(perch.hide(clock, "hide")); continue
            case .menu: ring.narration = NarrationOptions.parse(data) ?? NarrationOptions(); continue
            case .pause, .activity, .call, .narrationCheck: continue
            }
            guard event.seq > last else { exit(65) }
            last = event.seq
            pauseVisibility.status(event.state)
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
    var pauseVisibility = CursorPauseVisibility()
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
            case let .draw(plan, frame): write(plan.json.merging(["effect": "draw", "time": time, "frame": [frame.minX, frame.minY, frame.width, frame.height],
                "pauseControl": pauseVisibility.placement(plan, clip: clip, sprite: sprite).json]) { $1 })
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
            case .edge: continue
            case .pause: write(["effect": "drop", "state": "pause-channel", "time": clock]); continue
            case .clear: pauseVisibility.clear(); emit(runtime.hide(clock)); continue
            case .activity, .call: write(["effect": "drop", "state": "pause-control", "time": clock]); continue
            case .picker: write(["effect": "drop", "state": "picker", "dropped": true, "animations": [], "time": clock]); continue
            case let .narrationCheck(_, token):
                write(["effect": "narration-check", "token": token, "secure": secure, "time": clock]); continue
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
            case let .aim(_, value), let .status(_, value): pauseVisibility.status(value.state); event = value; delay = 0
            case .hide: emit(runtime.hide(clock)); continue
            case .menu:
                runtime.narration = NarrationOptions.parse(data) ?? NarrationOptions()
                write(["effect": "drop", "state": "menu", "dropped": true, "animations": [], "time": clock]); continue
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
func stageProducerDump(reader: Bool = false, characterPath: String? = nil) {
    let host = HandHost(), bounds = CGRect(x: 200, y: 500, width: 900, height: 350)
    let key = StageWindowKey(pid: 42, window: 7)
    var currentBounds = bounds, visible = true
    var ringPlans = 0, holdRing = false, probeEnabled = true
    var queued: RingPlan?, lastRingIdentity: StageProducerIdentity?
    host.readerFaulted = { host.producerHide(); writeStageProducerAck(["readerFault": true, "shown": host.perch.stage.shown]); exit(65) }
    host.readerFinished = { exit(0) }
    host.ringEnvironmentProvider = { RingEnvironment(bounds: { _, _ in currentBounds }, reduced: { true }, secure: { false }) }
    host.perch.stageEffects = { _ in }
    host.ringEffects = { effects in
        for (_, effect) in effects {
            if case let .draw(plan, _) = effect {
                ringPlans += 1; lastRingIdentity = plan.producer
                if holdRing { queued = plan } else { host.perch.ringDrew(plan) }
            }
        }
    }
    host.cursorStyle = "sprite"
    host.perch.enabled = true
    host.perch.stage.options.size = "stage"
    host.admissionWorld = { _ in
        StageWorld(base: PerchWorld(window: currentBounds, above: [], display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30, fullScreen: false),
            usable: CGRect(x: 0, y: 30, width: 1800, height: 1140), person: nil, pointer: CGPoint(x: 1750, y: 1150),
            inputAge: 20, pointerAway: 10, windows: visible ? [key: currentBounds] : [:])
    }
    if let path = characterPath {
        guard let bytes = FileManager.default.contents(atPath: path),
            let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            let parsed = handFrame(data), case let .character(_, frame) = parsed else { exit(65) }
        host.perch.stage.load(frame); host.perch.stage.stageArt = true
        host.perch.loaded = SpriteCharacter(frame: frame, images: [:], stage: SpriteStageCache(frame: frame))
    }
    func probe() {
        guard probeEnabled, host.perch.stage.base.frame != nil else { return }
        let ev = PerchEvent(state: "thinking", pid: 42, window: 7, at: CGPoint(x: 650, y: 700), ok: false, drop: nil, end: nil, windowRect: currentBounds)
        host.perch.stage.event = ev; host.perch.stage.lastFrame = 1
        _ = host.perch.stage.observe(1, world: host.admissionWorld?(ev), reduced: true)
    }
    func emit(_ ack: [String: Any]) {
        var row = ack
        row["references"] = host.producer.references.keys.sorted()
        row["retained"] = host.perch.stage.requiredReferences.values.flatMap { $0.map { $0.seq } }.sorted()
        row["watermark"] = host.perch.stage.admissionWatermarks[key] as Any? ?? NSNull()
        row["targetMemories"] = host.perch.stage.turnTargets.count
        row["targetBoxes"] = host.perch.stage.turnTargets.map { [Double($0.box.minX), Double($0.box.minY), Double($0.box.width), Double($0.box.height)] }
        row["protectedIntersections"] = host.perch.stage.shown ? host.perch.stage.activeTargets.filter { host.perch.stage.draw?.seat.box.intersects($0) == true }.count : 0
        row["epoch"] = host.producer.epoch; row["baselineLost"] = host.producer.baselineLost
        row["observation"] = host.producer.observation; row["shown"] = host.perch.stage.shown
        row["loaded"] = host.perch.stage.base.frame != nil
        row["unmappedWindows"] = host.perch.stage.unmappedWindows.map { [Int($0.pid), Int($0.window)] }.sorted { $0.lexicographicallyPrecedes($1) }
        row["active"] = host.producer.active; row["failed"] = host.producer.failed
        row["collectionOnly"] = host.perch.stage.producerCollectionOnly
        row["stageEvent"] = host.perch.stage.event?.state as Any? ?? NSNull()
        row["stageReaction"] = host.perch.stage.reaction
        row["ringPlans"] = ringPlans
        row["ringSession"] = lastRingIdentity?.session as Any? ?? NSNull()
        row["ringTurn"] = lastRingIdentity?.turn as Any? ?? NSNull()
        row["sessionState"] = host.producer.session as Any? ?? NSNull(); row["turnState"] = host.producer.turn as Any? ?? NSNull()
        row["recentEnded"] = host.producer.ended.count
        row["oldestEnded"] = host.producer.ended.first as Any? ?? NSNull()
        row["windows"] = host.panel == nil && host.perch.panel == nil && host.pauseOverlay.panel == nil ? 0 : 1
        row["layers"] = host.ringRoot == nil && host.hand == nil && host.glove == nil ? 0 : 1
        if let bytes = try? JSONSerialization.data(withJSONObject: row) { FileHandle.standardOutput.write(bytes + Data([10])) }
    }
    host.producerAck = { ack in
        let event = host.perch.stage.event, reaction = host.perch.stage.reaction
        probe()
        emit(ack.merging(["eventAtAck": event?.state as Any? ?? NSNull(), "reactionAtAck": reaction]) { _, new in new })
    }
    if reader { DispatchQueue.global(qos: .utility).async { host.read() }; dispatchMain() }
    var nonce: String?, last = -1
    while let line = readLine() {
        guard line.utf8.count < 65536, let bytes = line.data(using: .utf8), let data = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
        if data["dumpStats"] as? Bool == true { probe(); emit(["effect": "producer-stats"]); continue }
        if let hold = data["dumpHoldRing"] as? Bool { holdRing = hold; continue }
        if let enabled = data["dumpProbe"] as? Bool { probeEnabled = enabled; continue }
        if let paused = data["dumpPaused"] as? Bool { host.pauseControl.set(paused); continue }
        if let raw = data["dumpQueueTerminal"] as? [String: Any], let parsed = handFrame(raw), case var .status(_, event) = parsed {
            if let session = data["session"] as? String, let turn = data["turn"] as? String {
                event.producer = StageProducerIdentity(session: session, turn: turn)
            }
            var ring = RingRuntime(theme: .seamPlus, seed: 1)
            let env = RingEnvironment(bounds: { _, _ in currentBounds }, reduced: { true }, secure: { false })
            for (_, effect) in ring.receive(event, delay: 0, now: 0, env) {
                if case let .draw(plan, _) = effect { queued = plan }
            }
            guard queued != nil else { exit(65) }; continue
        }
        if data["dumpDrawQueued"] as? Bool == true, let plan = queued {
            host.perch.ringDrew(plan)
            emit(["effect": "producer-stats"]); queued = nil; continue
        }
        if data["dumpReload"] as? Bool == true { host.perch.stage.load(nil); continue }
        if let raw = data["dumpPublic"] as? [String: Any], let parsed = handFrame(raw) {
            switch parsed { case let .act(_, act): host.receiveAct(act)
                case let .aim(_, event), let .status(_, event): host.receiveCursor(event)
                default: exit(65) }; continue
        }
        if let rect = data["dumpBounds"] as? [Double], rect.count == 4 { currentBounds = CGRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]); continue }
        if let flag = data["dumpVisible"] as? Bool { visible = flag; host.perch.stage.observeWindows(visible ? [key: currentBounds] : [:]); continue }
        if let hand = data["hand"] as? String, hand != "stage-producer", let parsed = handFrame(data) {
            switch parsed { case let .act(token, act):
                    guard nonce == nil || nonce == token, handSequenceFresh(act.seq, after: last) else { exit(65) }
                    nonce = token; last = act.seq; host.receiveAct(act)
                case let .aim(token, event), let .status(token, event):
                    guard nonce == nil || nonce == token, handSequenceFresh(event.seq, after: last) else { exit(65) }
                    nonce = token; last = event.seq; host.receiveCursor(event)
                default: exit(65) }; continue
        }
        guard let frame = StageProducerFrame.parse(data, bytes: bytes.count + 1), nonce == nil || nonce == frame.nonce,
            handSequenceFresh(frame.seq, after: last) else { exit(65) }
        nonce = frame.nonce; last = frame.seq; host.receiveProducer(frame)
    }
}

#if SLEIGHT_CALL_SELFTEST
// No application, observers, input, audio, image decoding or windows. Only the metadata and install boundary are fake.
func callHostSelftest(_ slotRoot: String) {
    let owner = HandHost()
    owner.perch = PerchHost(host: owner, stageSlot: StageSlot(root: slotRoot))
    let perch = owner.perch
    owner.cursorStyle = "sprite"; perch.enabled = true; perch.lines = false
    perch.stageCall.requested = Double.greatestFiniteMagnitude
    let bounds = CGRect(x: 200, y: 500, width: 900, height: 350)
    perch.callTestWorld = StageWorld(base: PerchWorld(window: bounds, above: [], display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30, fullScreen: false),
        usable: CGRect(x: 0, y: 30, width: 1800, height: 1140), person: CGRect(x: 1450, y: 700, width: 300, height: 300),
        pointer: CGPoint(x: 1750, y: 1150), inputAge: 20, pointerAway: 10, windows: [StageWindowKey(pid: 42, window: 7): bounds], displayID: "1")
    let changed = perch.stageCall.changed
    var sequence = 0
    while let line = readLine() {
        guard line.utf8.count <= 32768, let bytes = line.data(using: .utf8),
            let row = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
        if let reduced = row["reduced"] as? Bool { perch.callTestReduced = reduced }
        if let clock = row["clock"] as? Double, clock.isFinite, clock >= 0,
            perch.callTestClock == nil || clock >= perch.callTestClock! {
            perch.callTestClock = clock
        } else if let timer = row["timer"] as? [String: Any], let after = timer["after"] as? Double,
            after.isFinite, after > 0, timer["action"] as? String == "line-out" {
            perch.runtime.timer(perch.now + after, "line-out"); perch.schedule()
        } else if let raw = row["character"] as? [String: Any], case var .character(_, frame)? = handFrame(raw) {
            let art = frame.perch!.table["perch"]!
            frame.stage = ["stage-lie": SpriteStageEntry(file: "fixture", cell: frame.cell, anchor: frame.perch!.anchor,
                filter: "nearest", next: [], art: art, fallback: "perch", fallbackArt: art)]
            perch.loaded = SpriteCharacter(frame: frame, images: [:], stage: SpriteStageCache(frame: frame))
            perch.runtime.load(frame); perch.runtime.book.enabled = false
            perch.stage.load(frame); perch.stage.stageArt = true
        } else if let enabled = row["callbacks"] as? Bool {
            perch.stageCall.changed = enabled ? changed : nil
        } else if let state = row["sample"] as? String, ["quiet", "input-active", "timeout", "unavailable"].contains(state) {
            perch.stageCall.complete((state == "quiet", state, state), at: perch.now, elapsedMs: 0)
        } else if row["ring"] as? Bool == true {
            sequence += 1
            var plan = RingPlan(state: row["state"] as? String ?? "thinking", at: CGPoint(x: 650, y: 700))
            plan.seq = sequence; plan.pid = 42; plan.window = 7; plan.windowRect = bounds
            plan.ok = row["ok"] as? Bool ?? false
            perch.ringDrew(plan)
        } else if row["settle"] as? Bool == true, let plan = perch.runtime.plan {
            perch.callTestClock = max(perch.now, perch.runtime.began + plan.duration + 0.001)
            perch.perform(perch.runtime.advance(to: perch.now, env: perch.environment))
        } else if row["observe"] as? Bool == true {
            perch.performStage(perch.stage.observe(perch.now, world: perch.stageEnvironment(), reduced: true))
        } else if row["samePoseTimer"] as? Bool == true {
            perch.runtime.timer(perch.now, "wait-end"); perch.observeLegacyCall()
        } else if let action = row["dueTimer"] as? String, action == "sleep" {
            perch.runtime.timer(perch.now, action); perch.observeLegacyCall()
        } else if let visible = row["panelVisible"] as? Bool {
            perch.callTestVisible = visible
        } else if let geometry = row["geometry"] as? String {
            var world = perch.callTestWorld!
            let old = world.base
            world.base = PerchWorld(window: geometry == "moved" ? bounds.offsetBy(dx: 30, dy: 0) : bounds,
                above: geometry == "covered" ? [CGRect(x: 0, y: 30, width: 1800, height: 1100)] : [],
                display: old.display, top: old.top, fullScreen: false)
            perch.callTestWorld = world; perch.observeLegacyCall()
        } else if row["receiveAfterDeep"] as? Bool == true {
            perch.runtime.timer(perch.now, "deep")
            var plan = RingPlan(state: "paused", at: CGPoint(x: 650, y: 700))
            plan.seq = sequence + 1; plan.pid = 42; plan.window = 7; plan.windowRect = bounds
            perch.ringDrew(plan)
        } else if row["installAgain"] as? Bool == true, let plan = perch.runtime.plan {
            perch.install(plan)
        } else if row["freshPlan"] as? Bool == true,
            let plan = perch.runtime.draw("paused", ok: false, at: nil, move: nil, from: nil, woke: false, now: perch.now, env: perch.environment) {
            perch.runtime.plan = plan; perch.install(plan)
        } else if row["queuedDraw"] as? Bool == true {
            // Plan against quiet metadata, then deliver after a live reading. Only the production apply hook can veto it.
            let world = perch.callTestWorld!
            let event = PerchEvent(state: "thinking", pid: 42, window: 7, at: CGPoint(x: 650, y: 700), ok: false, drop: nil, end: nil)
            let effects = perch.stage.receive(event, seq: 999, rect: nil, now: perch.now, world: world, reduced: true)
            precondition(effects.contains { if case .draw = $0 { return true }; return false })
            perch.stageCall.changed = nil
            perch.stageCall.complete((false, "input-active", "input-active"), at: perch.now, elapsedMs: 0)
            perch.performStage(effects)
        } else if row["admissionCall"] as? Bool == true {
            var world = perch.callTestWorld!; world.call = true
            precondition(!perch.stageAdmission(world), "call-hidden host must not claim a display slot")
        } else if row["trail"] as? Bool == true {
            perch.enabled = false; perch.lines = true; perch.callTestVisible = true
            if let loaded = perch.loaded {
                var frame = loaded.frame; frame.lines = PerchLineSet(lang: nil, lines: ["thinking": ["Thinking"]])
                perch.loaded = SpriteCharacter(frame: frame, images: loaded.images, stage: loaded.stage)
            }
        } else if row["schedule"] as? Bool == true { perch.schedule() }
        else if let seconds = row["wait"] as? Double, (0...3).contains(seconds) {
            RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
        } else if row["stats"] as? Bool != true { exit(65) }
        let legacyWake = perch.runtime.nextWake(perch.now, callHidden: perch.lastHideReason == "call")
        let out: [String: Any] = ["shown": perch.stageActive ? perch.stage.shown : perch.runtime.shown,
            "time": perch.now,
            "nextWake": legacyWake.map { ["at": $0.at, "source": $0.source, "leewayMs": $0.leeway] as [String: Any] } as Any? ?? NSNull(),
            "visible": perch.callTestVisible, "installs": perch.callTestInstalls,
            "pose": perch.runtime.plan?.cells.last?.state as Any? ?? NSNull(), "began": perch.runtime.began,
            "posePlan": perch.runtime.plan.map { $0.json(perch.runtime.metrics?.size ?? .zero) } as Any? ?? NSNull(),
            "timers": perch.runtime.timers.map { $0.action },
            "reason": (perch.stageActive ? perch.stage.hiddenReason : perch.lastHideReason) as Any? ?? NSNull(),
            "slot": perch.stageSlot.display as Any? ?? NSNull(), "size": perch.stage.options.size,
            "rung": perch.stage.seat?.rung as Any? ?? NSNull(), "wake": perch.wake != nil,
            "poll": perch.runtime.poll as Any? ?? NSNull(),
            "windows": owner.panel == nil && perch.panel == nil && perch.bubble == nil && owner.pauseOverlay.panel == nil ? 0 : 1,
            "layers": perch.root == nil && owner.ringRoot == nil ? 0 : 1]
        let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
    }
    perch.takeDown()
}
#endif
let arguments = Array(CommandLine.arguments.dropFirst(channelValidationOnly ? 2 : 1))
#if SLEIGHT_CALL_SELFTEST
if arguments.first == "--call-host-selftest" {
    guard arguments.count == 2, arguments[1].hasPrefix("/private/tmp/") else { exit(64) }
    callHostSelftest(arguments[1]); exit(0)
}
#endif
if arguments == ["--stage-call-query"] { exit(stageCallQueryMain()) }
if arguments == ["--stage-call-worker"] { exit(stageCallWorkerMain()) }
#if SLEIGHT_SEALED_SETTINGS
if arguments.first == "--settings" { exit(settingsMain(Array(arguments.dropFirst()))) }
#if SLEIGHT_KEYSTORE_PROBE
if arguments.first == "--key-store-probe" {
    guard arguments.count == 4, let store = try? KeychainKeyStore(probeGroup: arguments[3]) else { exit(69) }
    exit(store.probe(arguments[1], op: arguments[2]))
}
#endif
#endif
#if SLEIGHT_STAGE_BENCH
if arguments.first == "--stage-bench" { stageBenchMain(Array(arguments.dropFirst())); exit(0) }
#endif
if channelValidationOnly && arguments.first != "--hand" && arguments.first != "--hand-dump" { exit(64) }
if ["--stage-producer-dump", "--stage-producer-reader-dump"].contains(arguments.first ?? "") {
    guard (1...2).contains(arguments.count) else { exit(64) }
    stageProducerDump(reader: arguments[0] == "--stage-producer-reader-dump", characterPath: arguments.count == 2 ? arguments[1] : nil); exit(0)
}
if arguments == ["--stage-cache-dump"] { spriteStageCacheDump(); exit(0) }
if arguments == ["--honest-mood-dump"] { honestMoodDump(); exit(0) }
if arguments == ["--edge-chip-dump"] { edgeChipDump(); exit(0) }
if arguments == ["--pause-control-dump"] { cursorPauseDump(); exit(0) }
if arguments.first == "--cursor-menu-dump" { guard arguments.count == 1 else { exit(64) }; cursorMenuDump(); exit(0) }
if arguments.first == "--narration-audio-selftest" { guard arguments.count == 1 else { exit(64) }; narrationAudioSelftest(); exit(0) }
if arguments.first == "--narration-selftest" { guard arguments.count == 1 else { exit(64) }; narrationSelftest(); exit(0) }
if arguments.first == "--narration-voices" { guard arguments.count == 1 else { exit(64) }
    narrationJSON(narrationVoices().map { ["id": $0.identifier, "name": $0.name, "language": $0.language] }); exit(0) }
if arguments.first == "--narration-buffer-dump" { guard arguments.count == 1 else { exit(64) }; narrationBufferDump(); exit(0) }
if arguments.first == "--decode-sheet" { spriteDecodeChild(Array(arguments.dropFirst())) }
// `--check-character`: one character frame on stdin, the same checks and decode child as the live host, one JSON line out
// (loaded, reason, warnings). `sleight-mcp cursor check` runs it so the user sees why a character shows the ring alone.
if arguments.first == "--check-character" {
    // The optional second argument is a character bank folder: an absolute path, or it is a usage error.
    guard (1...2).contains(arguments.count), arguments.count == 1 || arguments[1].hasPrefix("/") else { exit(64) }
    var input = Data()
    while input.count <= 32768, case let chunk = FileHandle.standardInput.availableData, !chunk.isEmpty { input.append(chunk) }
    let line = input.split(separator: 10).first ?? Data()
    guard input.count <= 32769, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
        data["nonce"] as? String != nil, case let .character(_, frame)? = handFrame(data) else { exit(65) }
    let result = SpriteCharacter.check(frame, validateStage: true)
    let out = try! JSONSerialization.data(withJSONObject: ["id": frame.id, "loaded": result.character != nil,
        "reason": result.reason as Any? ?? NSNull(), "warnings": result.warnings], options: [.sortedKeys])
    FileHandle.standardOutput.write(out + Data([10]))
    exit(0)
}
if arguments == ["--settings-menu-dump"] {
    let bytes = try! JSONSerialization.data(withJSONObject: SettingsMenuPlan(menuOnly: true).json, options: [.sortedKeys])
    FileHandle.standardOutput.write(bytes + Data([10])); exit(0)
}
if arguments.first == "--stage-dump" {
    let flags = Array(arguments.dropFirst())
    guard flags.allSatisfy({ ["--reduce-motion", "--through-ring", "--legacy-perch"].contains($0) }), Set(flags).count == flags.count else { exit(64) }
    if flags.contains("--legacy-perch") {
        guard !flags.contains("--through-ring") else { exit(64) }
        perchDump(reduced: flags.contains("--reduce-motion"), seed: 1, callChecks: true); exit(0)
    }
    stageDump(reduced: flags.contains("--reduce-motion"), throughRing: flags.contains("--through-ring")); exit(0)
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
    let consent = mode == "--hand" && rest.last == "--consent", menuOnly = mode == "--hand" && ["--menu", "--settings-menu"].contains(rest.last ?? "")
    let settingsMenu = mode == "--hand" && rest.last == "--settings-menu"
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
    hand.settingsMenu = settingsMenu
    hand.demo = demo; hand.capture = capture; hand.cursorStyle = cursorStyle
    hand.ringRuntime = RingRuntime(theme: ringThemes[cursorStyle] ?? .seamPlus, seed: UInt64.random(in: 1...UInt64.max))
    if consent || menuOnly {
        let host = ConsentHost()
        host.settingsMenu = settingsMenu
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
