// Original sleight source. UI choices come only from native button/menu events.
// No accessibility grant, synthetic input, browser launch or page bridge.
// With --hand the same binary is the ghost hand's host instead: it only draws, and never writes stdout.
import AppKit
import Foundation
import CoreFoundation
import QuartzCore
import Carbon.HIToolbox
import ObjectiveC
import Darwin
import os.log

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
        guard let event = currentEvent(), event.window === sender.window,
            !typed || event.type == .keyDown,
            !mouseOnly || typed || [.leftMouseDown, .leftMouseUp].contains(event.type),
            event.timestamp <= ProcessInfo.processInfo.systemUptime,
            ProcessInfo.processInfo.systemUptime - event.timestamp < 5,
            personInput(event.cgEvent) else { refuseConsentInput(sender); return false }
        return sender.sendAction(originalAction, to: originalTarget)
    }
}

protocol ConsentWordFocusing: AnyObject {
    func focusWordField(_ field: ConsentWordField) -> Bool
}
// No field editor: only keyDown can change the private buffer. AX may read/focus this control, never fill or submit it.
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
    private var dispatching = false
    private var lastTimestamp: TimeInterval = -.infinity
    private var focusObserver: NSObjectProtocol?
    init(_ entries: [String: ConsentInputAction], instructions: String) {
        self.entries = entries
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
    override func accessibilityRole() -> NSAccessibility.Role? { .textField }
    override func accessibilityValue() -> String? { typed }
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
    override func setAccessibilityFocused(_ focused: Bool) {
        if focused { _ = focusForTyping() }
        else if window?.firstResponder === self { _ = window?.makeFirstResponder(nil) }
        super.setAccessibilityFocused(focused)
    }
    override func accessibilityPerformPress() -> Bool {
        return focusForTyping()
    }
    override func mouseDown(with event: NSEvent) { _ = focusForTyping() }
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
        stringValue = typed
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
// The shared host also shows the glove for the ghost hand: while the session's hand is on and sleight acted in the last five
// minutes. A turn's actions come in bursts with the person reading and typing between them, and five minutes keeps the glove
// (and its off switch) in the bar through that back-and-forth, then gives the bar back once the session goes quiet.
let handIdleWindow = 300.0
func menuVisible(_ status: String?, requests: Int, handEnabled: Bool, sinceAct: Double?) -> Bool {
    statusVisible(status, requests: requests) || handEnabled && (sinceAct.map { $0 >= 0 && $0 < handIdleWindow } ?? false)
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
    var lastAct: Date?
    var visibility: DispatchWorkItem?
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
        item.menu = menu
        let requests = pending.values.filter { ($0["data"] as? [String: Any])?["status"] == nil }.count
        let since = lastAct.map { Date().timeIntervalSince($0) }
        item.isVisible = menuVisible(status, requests: requests, handEnabled: hand?.enabled ?? false, sinceAct: since)
        // One work item hides the glove when the hand's window ends; none is left once it has.
        visibility?.cancel(); visibility = nil
        if let since = since, hand?.enabled == true, since < handIdleWindow {
            let check = DispatchWorkItem { [weak self] in self?.visibility = nil; self?.rebuildMenu() }
            visibility = check
            DispatchQueue.main.asyncAfter(deadline: .now() + handIdleWindow - since, execute: check)
        }
    }
    // The shared host's consent channel ended (its worker exited): an open card is aborted, its requests and status go, and the
    // hand stays.
    func channelClosed() { closeAsk(); modal.close(); pending.removeAll(); status = nil; consentOpen = false; rebuildMenu(); if !handOpen { NSApp.terminate(nil) } }
    // The hand channel ended or faulted: its state goes, and turbo's channel, if open, keeps the host.
    func handGone() { handOpen = false; hand = nil; permissions = nil; usage = nil; lastAct = nil; rebuildMenu(); if !consentOpen { NSApp.terminate(nil) } }
    func noteAct() { lastAct = Date(); rebuildMenu() }
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
    func menuNeedsUpdate(_ menu: NSMenu) { fillPermissions(menu) }
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
}
// menu: the hand's setting, capture mode and the plugin version, for the shared host's Ghost Hand row.
// permissions: the Permissions submenu's rows (permissionsData), when the relay has them. usage: the usage row (usageData),
// when this session writes the action log and it has timed actions. A usage value this host can't admit drops only that row:
// a bad number must never take the glove down.
enum HandFrame { case act(String, HandAct), hide(String), menu(String, enabled: Bool, capture: String, version: String, permissions: PermissionsData?, usage: UsageStats?) }
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
    guard let nonce = data["nonce"] as? String, nonce.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
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
    guard data["hand"] as? String == "act",
        Set(data.keys) == ["hand", "nonce", "seq", "kind", "pid", "windowId", "at", "path", "delayMs", "beats"],
        let seq = integer(data["seq"], 0...9007199254740991), let kind = data["kind"] as? String, handKinds.contains(kind),
        let pid = integer(data["pid"], 1...2147483647), let windowId = integer(data["windowId"], 1...4294967295),
        let at = point(data["at"]), let raw = data["path"] as? [Any], (1...64).contains(raw.count),
        let delay = integer(data["delayMs"], 0...10000), let beats = integer(data["beats"], 1...20) else { return nil }
    let path = raw.compactMap(point)
    guard path.count == raw.count else { return nil }
    return .act(nonce, HandAct(seq: seq, kind: kind, pid: Int32(pid), windowId: UInt32(windowId), at: at, path: path,
        delay: Double(delay) / 1000, beats: beats))
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
// END HAND FRAME

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
    var idle: Bool { panel == nil && hand == nil && glove == nil && dabs == nil && pending.isEmpty && fading == nil }

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
                guard line.count <= 8192, let data = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                    let frame = handFrame(data) else { fault(); continue lines }
                switch frame {
                case let .hide(nonce):
                    guard nonceBook.admit("hand", nonce) else { fault(); continue lines }
                    DispatchQueue.main.async { self.hide() }
                case let .act(nonce, act):
                    guard nonceBook.admit("hand", nonce), act.seq > last else { fault(); continue lines }
                    last = act.seq
                    DispatchQueue.main.async { self.consent?.noteAct(); self.schedule(act) }
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
        fading?.cancel(); release()
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

// No arguments: the consent host. --hand [--capture=…] [--menu|--consent], --hand-demo X,Y,W,H [--capture=…] and
// --hand-dump [--capture=…]: the hand. With --consent the hand host is the session's shared host: turbo's consent channel
// runs on fds 3 (in) and 4 (out) beside the hand's stdin, and the menu bar glove serves both. --menu is the hand-only host: the glove and its
// hand-only menu, with no consent channel.
let arguments = Array(CommandLine.arguments.dropFirst())
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
    guard ["--hand", "--hand-demo", "--hand-dump"].contains(mode), let capture = handCapture(rest) else { exit(64) }
    if mode == "--hand-dump" {
        guard let bytes = try? JSONSerialization.data(withJSONObject: handDump(capture: capture), options: [.sortedKeys]) else { exit(70) }
        FileHandle.standardOutput.write(bytes + Data([10]))
        exit(0)
    }
    let hand = HandHost()
    hand.demo = demo; hand.capture = capture
    if consent || menuOnly {
        let host = ConsentHost()
        host.input = consent ? FileHandle(fileDescriptor: 3, closeOnDealloc: true) : nil
        if consent { host.output = FileHandle(fileDescriptor: 4, closeOnDealloc: true) }
        host.shared = true
        hand.consent = host
    }
    app.setActivationPolicy(.accessory)
    app.delegate = hand
    app.run()
}
