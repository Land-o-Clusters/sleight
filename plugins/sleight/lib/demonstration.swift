// Passive AX notifications plus a listen-only mouse tap for clicks (AX has no press notification).
// No AX writes, posted events, activation, permission requests, key text or persisted coordinates.
import AppKit
import ApplicationServices
import Foundation

func output(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1)
}
func attr(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success ? value : nil
}
func string(_ node: AXUIElement, _ name: String) -> String { attr(node, name) as? String ?? "" }
func element(_ node: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attr(node, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func children(_ node: AXUIElement) -> [AXUIElement] { attr(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] }

final class Observation {
    let pid: pid_t
    let app: AXUIElement
    let window: AXUIElement
    var observer: AXObserver?
    var tap: CFMachPort?
    var registered: [AXUIElement] = []
    var emptyFields: [AXUIElement] = []
    var nodes: [AXUIElement] = []
    var down: AXUIElement?
    var dragged = false
    var lastMenu: AXUIElement?
    var interaction = 0
    var menuInteraction = ""
    var menuTime = Date.distantPast

    init(_ bundle: String) {
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
        guard running.count == 1 else { fail("Open exactly one instance of the selected app yourself before recording") }
        pid = running[0].processIdentifier; app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let focused = element(app, kAXFocusedWindowAttribute) else { fail("Selected app has no focused window") }
        window = focused
        guard let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1 else { fail("Recording requires exactly one app window") }
        checkWindow()
    }
    func stop(_ reason: String) -> Never { output(["kind": "unsupported", "reason": reason]); exit(1) }
    func checkWindow() {
        guard let focused = element(app, kAXFocusedWindowAttribute), CFEqual(focused, window) else { stop("window-changed") }
        let subrole = string(window, kAXSubroleAttribute)
        if subrole == "AXDialog" || subrole == "AXSystemDialog" || (attr(window, kAXModalAttribute) as? Bool) == true ||
            !(attr(window, "AXSheets") as? [AXUIElement] ?? []).isEmpty ||
            children(window).contains(where: { string($0, kAXRoleAttribute) == "AXSheet" }) { stop("dialog or sheet") }
    }
    func scan() {
        nodes = []
        func visit(_ node: AXUIElement, _ depth: Int) {
            if nodes.contains(where: { CFEqual($0, node) }) { return }
            if nodes.count >= 2000 || depth > 40 { stop("accessibility tree exceeds observation limit") }
            nodes.append(node)
            if string(node, kAXRoleAttribute) == "AXWebArea" { return }
            for child in children(node) { visit(child, depth + 1) }
        }
        visit(window, 0)
        if let menu = element(app, kAXMenuBarAttribute) { visit(menu, 0) }
    }
    func description(_ node: AXUIElement) -> [String: Any] {
        let role = string(node, kAXRoleAttribute), subrole = string(node, kAXSubroleAttribute)
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { stop("secure field") }
        let id = string(node, kAXIdentifierAttribute)
        func label(_ node: AXUIElement) -> String {
            let title = string(node, kAXTitleAttribute)
            return title.isEmpty ? string(node, kAXDescriptionAttribute) : title
        }
        let name = label(node)
        var settable = DarwinBoolean(false)
        let editable = AXUIElementIsAttributeSettable(node, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
        return ["role": role, "secure": false, "editable": editable, "id": id, "label": name,
                "idCount": id.isEmpty ? 0 : nodes.filter { string($0, kAXIdentifierAttribute) == id }.count,
                "labelCount": name.isEmpty ? 0 : nodes.filter { label($0) == name }.count]
    }
    func editableText(_ node: AXUIElement) -> Bool {
        guard ["AXTextArea", "AXTextField"].contains(string(node, kAXRoleAttribute)) else { return false }
        return (description(node)["editable"] as? Bool) == true
    }
    func event(_ kind: String, _ node: AXUIElement, _ interactionID: String? = nil) {
        checkWindow(); scan()
        var data: [String: Any] = ["kind": kind, "element": description(node)]
        if let interactionID { data["interaction"] = interactionID }
        if kind == "value" {
            guard editableText(node) else { return }
            guard emptyFields.contains(where: { CFEqual($0, node) }) else { stop("text field lacks an empty baseline; start with an empty native field") }
            guard let focus = element(app, kAXFocusedUIElementAttribute), CFEqual(focus, node) else { stop("value changed outside the focused field") }
            guard let value = attr(node, kAXValueAttribute) as? String, value.utf8.count <= 1_048_576 else { stop("text value unavailable or too large") }
            data["value"] = value
        }
        output(data)
    }
    func subscribe() {
        guard let observer else { return }
        scan()
        for node in nodes where !registered.contains(where: { CFEqual($0, node) }) {
            let role = string(node, kAXRoleAttribute)
            let names = role == "AXMenuItem" ? [kAXMenuItemSelectedNotification] :
                editableText(node) ? [kAXValueChangedNotification] : []
            for name in names {
                let result = AXObserverAddNotification(observer, node, name as CFString, Unmanaged.passUnretained(self).toOpaque())
                if result != .success && result != .notificationAlreadyRegistered { stop("required accessibility notification is unavailable") }
            }
            registered.append(node)
        }
    }
    func start() {
        // Inspect emptiness once, before notifications or input observation. Never emit prior text.
        scan()
        for node in nodes where editableText(node) {
            let spec = description(node)
            guard let value = attr(node, kAXValueAttribute) as? String, value.isEmpty else { continue }
            emptyFields.append(node)
            output(["kind": "baseline", "element": spec, "empty": true])
        }
        let callback: AXObserverCallback = { _, node, notification, raw in
            guard let raw else { return }
            let state = Unmanaged<Observation>.fromOpaque(raw).takeUnretainedValue()
            if notification as String == kAXFocusedUIElementChangedNotification {
                state.event("focus", element(state.app, kAXFocusedUIElementAttribute) ?? node); state.subscribe()
            } else if notification as String == kAXMenuItemSelectedNotification {
                if let last = state.lastMenu, CFEqual(last, node), Date().timeIntervalSince(state.menuTime) < 1 {
                    state.event("menu", node, state.menuInteraction)
                } else { state.stop("menu notification could not be matched to an observed click") }
            } else if notification as String == kAXValueChangedNotification { state.event("value", node) }
            else { state.checkWindow(); state.subscribe() }
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { stop("AX observer unavailable") }
        for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification, kAXWindowCreatedNotification] {
            guard AXObserverAddNotification(observer, app, name as CFString, Unmanaged.passUnretained(self).toOpaque()) == .success else { stop("app notification unavailable") }
        }
        subscribe()
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        let mask = [CGEventType.leftMouseDown, .leftMouseUp, .leftMouseDragged, .rightMouseDown, .scrollWheel, .keyDown]
            .reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask,
            callback: { _, type, event, raw in
                guard let raw else { return Unmanaged.passUnretained(event) }
                let state = Unmanaged<Observation>.fromOpaque(raw).takeUnretainedValue()
                state.mouse(type, event)
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        guard let tap, let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { stop("listen-only event observation unavailable") }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
        CGEvent.tapEnable(tap: tap, enable: true)
        var ready: [String: Any] = ["kind": "ready", "title": string(window, kAXTitleAttribute)]
        let url = string(window, kAXDocumentAttribute)
        if !url.isEmpty { ready["url"] = url }
        output(ready)
    }
    func mouse(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { stop("event observation interrupted") }
        if type == .keyDown {
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
            checkWindow()
            guard let focus = element(app, kAXFocusedUIElementAttribute), editableText(focus),
                  emptyFields.contains(where: { CFEqual($0, focus) }),
                  !event.flags.contains(.maskCommand), !event.flags.contains(.maskControl) else { stop("keyboard shortcut or typing outside an empty editable native field") }
            // AX value changes record native text. No key code or character is read.
            _ = description(focus); return
        }
        if type == .leftMouseDragged { if down != nil { dragged = true }; return }
        if type == .leftMouseUp {
            defer { down = nil; dragged = false }
            guard let node = down else { return }
            if dragged { stop("drag") }
            _ = node
            return
        }
        var hit: AXUIElement?
        let point = event.location
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit else {
            stop("click hit-test unavailable")
        }
        var owner: pid_t = 0; AXUIElementGetPid(hit, &owner)
        guard owner == pid else { return }
        checkWindow()
        if type == .leftMouseDown {
            down = hit; dragged = false
            let role = string(hit, kAXRoleAttribute)
            if ["AXButton", "AXMenuBarItem", "AXMenuItem", "AXCheckBox", "AXRadioButton"].contains(role) { eventClick(hit, role) }
            else if !["AXTextArea", "AXTextField", "AXScrollArea"].contains(role) { stop("unsupported click") }
        }
        else if type == .scrollWheel || type == .rightMouseDown { stop("scroll or secondary click") }
    }
    func eventClick(_ node: AXUIElement, _ role: String) {
        interaction += 1
        let id = "mouse-\(interaction)"
        if role == "AXMenuItem" { menuTime = Date(); lastMenu = node; menuInteraction = id }
        event("click", node, id)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--check"] { output(["trusted": AXIsProcessTrusted(), "listening": CGPreflightListenEventAccess()]); exit(0) }
if args == ["--routine-state"] {
    let apps: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { app in
        guard let bundle = app.bundleIdentifier, let name = app.localizedName else { return nil }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 0.3)
        let windows = (attr(ax, kAXWindowsAttribute) as? [AXUIElement] ?? []).map { win -> [String: Any] in
            var info: [String: Any] = ["title": string(win, kAXTitleAttribute)]
            let url = string(win, kAXDocumentAttribute)
            if !url.isEmpty { info["url"] = url }
            return info
        }
        return ["bundle": bundle, "name": name, "pid": Int(app.processIdentifier), "windows": windows]
    }
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
    output(["idleSeconds": idle, "apps": apps]); exit(0)
}
guard args.count == 2, args[0].range(of: #"^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"#, options: .regularExpression) != nil,
      let seconds = Double(args[1]), seconds >= 1, seconds <= 3600 else { fail("invalid observer arguments") }
guard AXIsProcessTrusted() else { fail("Accessibility unavailable; no permission requested") }
guard CGPreflightListenEventAccess() else { fail("Input Monitoring unavailable; no permission requested") }
let observation = Observation(args[0]); observation.start()
signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
interrupt.setEventHandler { CFRunLoopStop(CFRunLoopGetMain()) }
terminate.setEventHandler { exit(1) }
interrupt.resume(); terminate.resume()
CFRunLoopRunInMode(.defaultMode, seconds, false)
if observation.down != nil { observation.stop("mouse interaction incomplete") }
if let tap = observation.tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
output(["kind": "complete"])
