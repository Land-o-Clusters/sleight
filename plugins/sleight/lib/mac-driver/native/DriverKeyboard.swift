import Foundation
import AppKit
import ApplicationServices
import Carbon

// Clean-room implementation. Layout, event, focus and menu adapters own the OS
// boundary. Construction and registration do not touch the desktop.
struct DriverKeyboardMapping {
    let keyCode: Int
    let modifiers: [String]
    // Safety-only translations never participate in ordinary character mapping.
    var safetyCharacters: [String] = []
}
struct DriverKeyboardEvent {
    let type: String
    let keyCode: Int
    let flags: UInt64
    var unicode: String? = nil
    var json: DriverObject {
        var out: DriverObject = ["type": type, "keyCode": keyCode, "flags": flags]
        if let unicode = unicode { out["unicode"] = unicode }
        return out
    }
}
struct DriverKeyboardFault: Error {
    let code: String
    let delivery: String
    let cleanupComplete: Bool
    let unhealthy: Bool
    var focusChanged = false
    var focusRestored = false
    var fakeActiveMs: Double = 0
    var charactersDelivered: Int? = nil
    var menuFallbackCount = 0
    var menuNote: String? = nil
    var personTookOver: Bool? = nil
    var reason: String? = nil
    var charactersPosted: Int? = nil
    var compositionBypassed: Bool? = nil
    var textBeliefFallback: Bool? = nil
    var message: String? = nil
    var json: DriverObject {
        var value: DriverObject = ["code": code, "message": message ?? code, "unhealthy": unhealthy, "delivery": delivery,
         "retry": delivery == "not-sent" ? "safe" : "read-first",
         "personTookOver": personTookOver ?? (code == "PERSON_TOOK_OVER"), "settled": false,
         "cleanupComplete": cleanupComplete, "focusChanged": focusChanged, "focusRestored": focusRestored,
         "menuFallbackCount": menuFallbackCount]
        value["fakeActiveMs"] = fakeActiveMs
        if let count = charactersDelivered { value["charactersDelivered"] = count }
        if let menuNote = menuNote { value["note"] = menuNote }
        if let reason = reason { value["reason"] = reason }
        if let count = charactersPosted { value["charactersPosted"] = count }
        if let bypassed = compositionBypassed { value["compositionBypassed"] = bypassed }
        if let fallback = textBeliefFallback { value["textBeliefFallback"] = fallback }
        if code == "ACTION_UNSUPPORTED" && delivery == "not-sent" { value["clipboard"] = "untouched" }
        return value
    }
}

// Values stay inside this call. The wire receives counts, never field contents.
struct DriverTextSnapshot {
    let element: CFTypeRef
    let window: CFTypeRef
    let value: String?
    let selection: NSRange?
    func sameTarget(_ other: DriverTextSnapshot) -> Bool {
        CFEqual(element, other.element) && CFEqual(window, other.window)
    }
    func inserting(_ text: String) -> (String, NSRange)? {
        guard let value = value, let range = selection, range.location >= 0, range.length >= 0,
              range.location <= value.utf16.count, range.length <= value.utf16.count - range.location else { return nil }
        return ((value as NSString).replacingCharacters(in: range, with: text),
            NSRange(location: range.location + text.utf16.count, length: 0))
    }
    func matches(_ expected: (String, NSRange)) -> Bool {
        // Swift String equality folds canonically equivalent Unicode. Delivery
        // checks require the exact requested UTF-16 units instead.
        value?.utf16.elementsEqual(expected.0.utf16) == true && selection == expected.1
    }
}

struct DriverTextAccess {
    var application: (Int32) -> CFTypeRef
    var isElement: (CFTypeRef) -> Bool
    var pid: (CFTypeRef) -> Int32?
    var copy: (CFTypeRef, String, Double) throws -> CFTypeRef?
    static var system: DriverTextAccess {
        DriverTextAccess(application: { AXUIElementCreateApplication($0) },
            isElement: { CFGetTypeID($0) == AXUIElementGetTypeID() }, pid: { element in
                var pid: pid_t = 0
                return AXUIElementGetPid(element as! AXUIElement, &pid) == .success ? pid : nil
            }, copy: { element, name, remaining in
                let ax = element as! AXUIElement
                AXUIElementSetMessagingTimeout(ax, Float(min(0.01, remaining)))
                var value: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(ax, name as CFString, &value)
                if status == .noValue || status == .attributeUnsupported { return nil }
                guard status == .success else { throw DriverFault("AX_UNAVAILABLE") }
                return value
            })
    }
}

// Internal keyboard issues are not helper wire codes. Registration must map the
// final DriverKeyboardFault through its explicit disposition-preserving adapter.
private struct DriverKeyboardIssue: Error {
    let code: String
    init(_ code: String) { self.code = code }
}

struct DriverKeyboardMenuItem {
    let character: String?
    let virtualKey: Int?
    let modifiers: Int?
    let glyph: Int?
    let enabled: Bool
    let title: String?
    let mark: String?
    let metadataValid: Bool
    let press: (Int32, () throws -> Void) throws -> Void
    static func enabledValue(_ value: Any?) -> Bool {
        guard let value = value, CFGetTypeID(value as CFTypeRef) == CFBooleanGetTypeID() else { return false }
        return (value as? Bool) == true
    }
    init(attributes: DriverObject, enabled: Any?, press: @escaping (Int32, () throws -> Void) throws -> Void) {
        let char = attributes[kAXMenuItemCmdCharAttribute] as? String
        let code = driverInteger(attributes[kAXMenuItemCmdVirtualKeyAttribute])
        let mods = driverInteger(attributes[kAXMenuItemCmdModifiersAttribute])
        let glyph = driverInteger(attributes[kAXMenuItemCmdGlyphAttribute])
        title = attributes[kAXTitleAttribute] as? String; mark = attributes[kAXMenuItemMarkCharAttribute] as? String
        character = char; virtualKey = code; modifiers = mods; self.glyph = glyph
        self.enabled = Self.enabledValue(enabled); self.press = press
        metadataValid = (attributes[kAXMenuItemCmdCharAttribute] == nil || char != nil) &&
            (attributes[kAXMenuItemCmdVirtualKeyAttribute] == nil || code != nil) &&
            (attributes[kAXMenuItemCmdModifiersAttribute] == nil || mods != nil) &&
            (attributes[kAXMenuItemCmdGlyphAttribute] == nil || glyph != nil) &&
            (attributes[kAXTitleAttribute] == nil || title != nil) &&
            (attributes[kAXMenuItemMarkCharAttribute] == nil || mark != nil)
    }
}

final class DriverKeyboard {
    typealias Send = (Int32) throws -> Void
    typealias Guard = (DriverRequest, DriverCore) throws -> Void
    typealias IntervalGuards = (DriverRequest, DriverCore) throws -> (check: () throws -> Void, identity: () throws -> Void)
    static let order = ["control", "alt", "shift", "meta"]
    static let modifiers: [String: (Int, UInt64)] = [
        "control": (59, 0x40000), "alt": (58, 0x80000),
        "shift": (56, 0x20000), "meta": (55, 0x100000)]
    static let modifierAliases = [
        "ctrl": "control", "control_l": "control", "control_r": "control", "ctrl_l": "control", "ctrl_r": "control",
        "option": "alt", "alt_l": "alt", "alt_r": "alt", "option_l": "alt", "option_r": "alt",
        "shift_l": "shift", "shift_r": "shift", "super": "meta", "command": "meta", "cmd": "meta",
        "super_l": "meta", "super_r": "meta", "meta_l": "meta", "meta_r": "meta"]
    static let named: [String: Int] = [
        "Return": 36, "Tab": 48, "Space": 49, "BackSpace": 51, "Escape": 53, "Delete": 117,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121, "Left": 123, "Right": 124, "Down": 125, "Up": 126,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101,
        "F10": 109, "F11": 103, "F12": 111, "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64, "F18": 79, "F19": 80, "F20": 90,
        "KP_Enter": 76, "KP_Add": 69, "KP_Subtract": 78, "KP_Multiply": 67, "KP_Divide": 75, "KP_Decimal": 65,
        "KP_Equal": 81, "KP_0": 82, "KP_1": 83, "KP_2": 84, "KP_3": 85, "KP_4": 86, "KP_5": 87, "KP_6": 88, "KP_7": 89, "KP_8": 91, "KP_9": 92]
    static let keyAliases = [
        "enter": "Return", "esc": "Escape", "space": "Space", "backspace": "BackSpace", "del": "Delete",
        "page_up": "PageUp", "prior": "PageUp", "page_down": "PageDown", "next": "PageDown",
        "plus": "+", "minus": "-", "equal": "=", "comma": ",", "period": ".", "slash": "/", "backslash": "\\",
        "semicolon": ";", "apostrophe": "'", "quotedbl": "\"", "grave": "`", "asciitilde": "~",
        "bracketleft": "[", "bracketright": "]", "braceleft": "{", "braceright": "}",
        "exclam": "!", "at": "@", "numbersign": "#", "dollar": "$", "percent": "%", "asciicircum": "^",
        "ampersand": "&", "asterisk": "*", "parenleft": "(", "parenright": ")", "underscore": "_",
        "colon": ":", "less": "<", "greater": ">", "question": "?", "bar": "|"]

    struct Arguments {
        var key: String? = nil
        var keys: [String] = []
        var text: String? = nil
        var state: String? = nil
    }
    static func sorted(_ keys: [String]) -> [String] { order.filter { keys.contains($0) } }
    static func flags(_ keys: [String]) -> UInt64 { keys.reduce(0) { $0 | modifiers[$1]!.1 } }
    static func validText(_ value: Any?) throws -> String {
        guard let text = value as? String, text.utf16.count <= 16384,
              !text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13].contains($0.value) || $0.value == 127 }) else { throw DriverFault("INVALID_PARAMS") }
        return text
    }
    static func parse(_ method: String, _ args: [Any]) throws -> Arguments {
        guard args.count == 1 else { throw DriverFault("INVALID_PARAMS") }
        if method == "typeText" { return Arguments(text: try validText(args[0])) }
        if method == "modifiers" {
            guard let value = args[0] as? DriverObject, Set(value.keys) == Set(["keys", "state"]),
                  let keys = value["keys"] as? [String], !keys.isEmpty, keys.count <= 4,
                  Set(keys).count == keys.count, keys.allSatisfy({ order.contains($0) }),
                  let state = value["state"] as? String, ["down", "up"].contains(state) else { throw DriverFault("INVALID_PARAMS") }
            return Arguments(keys: sorted(keys), state: state)
        }
        guard method == "pressKey", let chord = args[0] as? String, !chord.isEmpty, chord.utf16.count <= 256,
              !chord.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || $0.value < 32 || $0.value == 127 }) else { throw DriverFault("INVALID_PARAMS") }
        var result = Arguments()
        for part in chord.components(separatedBy: "+") {
            guard !part.isEmpty, result.key == nil else { throw DriverFault("INVALID_PARAMS") }
            let lower = part.lowercased()
            if let mod = modifierAliases[lower] ?? (order.contains(lower) ? lower : nil) {
                guard !result.keys.contains(mod) else { throw DriverFault("INVALID_PARAMS") }
                result.keys.append(mod)
            } else {
                let key = keyAliases[lower] ?? named.keys.first(where: { $0.lowercased() == lower }) ?? part
                guard named[key] != nil || key.unicodeScalars.count == 1 else { throw DriverFault("INVALID_PARAMS") }
                result.key = key
            }
        }
        result.keys = sorted(result.keys)
        return result
    }
    static func mapping(_ key: String, _ layout: [String: DriverKeyboardMapping]) throws -> DriverKeyboardMapping {
        if let code = named[key] { return DriverKeyboardMapping(keyCode: code, modifiers: []) }
        guard let map = layout[key], (0...127).contains(map.keyCode),
              map.modifiers.allSatisfy({ ["shift", "alt"].contains($0) }), Set(map.modifiers).count == map.modifiers.count else { throw DriverKeyboardIssue("KEY_UNMAPPABLE") }
        return map
    }
    static func stroke(_ code: Int?, _ keys: [String], unicode: String? = nil,
                       strategy: String = "flags-changed", held: [String] = []) -> [DriverKeyboardEvent] {
        let added = sorted(keys).filter { !held.contains($0) }
        let all = sorted(keys + held)
        var result = [DriverKeyboardEvent](), active = held
        if strategy != "flags-only" {
            for key in added {
                active.append(key)
                result.append(DriverKeyboardEvent(type: strategy == "key-events" ? "keyDown" : "flagsChanged", keyCode: modifiers[key]!.0, flags: flags(active)))
            }
        }
        if let code = code {
            result.append(DriverKeyboardEvent(type: "keyDown", keyCode: code, flags: flags(all), unicode: unicode))
            result.append(DriverKeyboardEvent(type: "keyUp", keyCode: code, flags: flags(all), unicode: unicode))
        }
        if strategy != "flags-only" {
            for key in added.reversed() {
                active.removeAll { $0 == key }
                result.append(DriverKeyboardEvent(type: strategy == "key-events" ? "keyUp" : "flagsChanged", keyCode: modifiers[key]!.0, flags: flags(active)))
            }
        }
        return result
    }
    static func plan(_ method: String, _ args: Arguments, layout: [String: DriverKeyboardMapping],
                     strategy: String, held: [String]) throws -> [DriverKeyboardEvent] {
        guard ["flags-changed", "flags-only", "key-events"].contains(strategy) else { throw DriverFault("INVALID_PARAMS") }
        if method == "pressKey" {
            guard let key = args.key else { return stroke(nil, args.keys, held: held) }
            let map = try mapping(key, layout)
            return stroke(map.keyCode, sorted(args.keys + map.modifiers), strategy: strategy, held: held)
        }
        if method == "modifiers" {
            var active = held, out = [DriverKeyboardEvent]()
            let keys = args.state == "up" ? Array(args.keys.reversed()) : args.keys
            for key in keys {
                if args.state == "down" && !active.contains(key) { active.append(key) }
                else if args.state == "up" && active.contains(key) { active.removeAll { $0 == key } }
                else { continue }
                out.append(DriverKeyboardEvent(type: "flagsChanged", keyCode: modifiers[key]!.0, flags: flags(active)))
            }
            return out
        }
        guard held.isEmpty else { throw DriverKeyboardIssue("MODIFIERS_HELD") }
        var result = [DriverKeyboardEvent](), chunk = ""
        func flush() {
            if !chunk.isEmpty { result += stroke(0, [], unicode: chunk); chunk = "" }
        }
        // Iterate Unicode scalars, not Character, so a long combining sequence
        // cannot exceed the 32 UTF-16-unit event payload bound.
        for scalar in args.text!.unicodeScalars {
            let char = String(scalar)
            let map: DriverKeyboardMapping?
            if scalar.value == 10 || scalar.value == 13 { map = DriverKeyboardMapping(keyCode: 36, modifiers: []) }
            else if scalar.value == 9 { map = DriverKeyboardMapping(keyCode: 48, modifiers: []) }
            else { map = layout[char] == nil ? nil : try mapping(char, layout) }
            if let map = map { flush(); result += stroke(map.keyCode, sorted(map.modifiers), unicode: char) }
            else { if chunk.utf16.count + char.utf16.count > 32 { flush() }; chunk += char }
        }
        flush()
        return result
    }

    private let layout: () throws -> [String: DriverKeyboardMapping]
    private let makeEvent: (DriverKeyboardEvent) throws -> Send
    private let ladder: () -> String?
    private let beforeInput: Guard
    private let intervalGuards: IntervalGuards?
    private let pause: () -> Void
    private let nativeTransport: Bool
    private let focus: DriverFocusBelief?
    private let textBelief: () -> String?
    private let textSnapshot: (Int32, String, Double, Bool) throws -> DriverTextSnapshot
    private let inputMethod: () -> Bool
    private let menuItems: (DriverRequest, DriverCore, Int32) throws -> [DriverKeyboardMenuItem]
    private struct Fallback {
        let args: Arguments
        let layout: [String: DriverKeyboardMapping]
        let pid: Int32
        let text: String
        let focus: DriverFocusSnapshot?
        let menu: DriverKeyboardMenuItem
        let started: Double
        var deliveryUnconfirmed = false
    }
    private var fallback: Fallback?
    private var shortcutText: String?
    private var held: [String] = []
    private var heldBinding: String? = nil
    private var heldRelease: (() throws -> Void)?
    private var inputRelease: DriverInputRelease?
    func releaseHeld() throws {
        guard !held.isEmpty else { heldRelease = nil; return }
        defer { held = []; heldBinding = nil; heldRelease = nil; inputRelease?.clear("keyboard") }
        try heldRelease?()
    }

    init(layout: @escaping () throws -> [String: DriverKeyboardMapping] = DriverKeyboard.systemLayout,
         makeEvent: ((DriverKeyboardEvent) throws -> Send)? = nil,
         ladder: @escaping () -> String? = { ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_KEY_LADDER"] },
         pause: @escaping () -> Void = { Thread.sleep(forTimeInterval: 0.004) },
         focus: DriverFocusBelief? = nil,
         textBelief: @escaping () -> String? = { ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_TEXT_BELIEF"] },
         textSnapshot: @escaping (Int32, String, Double, Bool) throws -> DriverTextSnapshot = DriverKeyboard.systemTextSnapshot,
         inputMethod: @escaping () -> Bool = DriverKeyboard.systemInputMethod,
         menuItems: ((DriverRequest, DriverCore, Int32) throws -> [DriverKeyboardMenuItem])? = nil,
         intervalGuards: IntervalGuards? = nil,
         beforeInput: @escaping Guard) {
        self.layout = layout; self.ladder = ladder; nativeTransport = makeEvent == nil
        if let makeEvent = makeEvent { self.makeEvent = makeEvent }
        else {
            var source: CGEventSource?
            self.makeEvent = { spec in
                if source == nil { source = CGEventSource(stateID: .privateState) }
                guard let source = source else { throw DriverKeyboardIssue("EVENT_CREATE_FAILED") }
                return try DriverKeyboard.systemEvent(spec, source: source)
            }
        }
        self.beforeInput = beforeInput; self.pause = pause
        self.intervalGuards = intervalGuards
        self.focus = focus ?? (makeEvent == nil ? DriverFocusBelief() : nil)
        self.textBelief = textBelief; self.textSnapshot = textSnapshot; self.inputMethod = inputMethod
        self.menuItems = menuItems ?? { request, core, pid in
            guard core.inventory.fixture == nil else { throw DriverFault("ACTION_UNSUPPORTED") }
            return try Self.systemMenuItems(request, pid: pid)
        }
    }
    // Integration must translate the fault's disposition fields into DriverFault.
    // Requiring an adapter avoids silently treating a partially sent action as safe.
    func register(in runtime: DriverRuntime, fault: @escaping (DriverKeyboardFault) -> Error) {
        inputRelease = runtime.inputRelease
        runtime.releaseHeldInput = { [self] in try releaseHeld() }
        for method in ["pressKey", "typeText", "modifiers"] {
            runtime.registerAction(method: method, handler: { [self] request, core in
                do { return try handle(request, core: core) }
                catch let failure as DriverKeyboardFault { throw fault(failure) }
            }, afterObservation: { [self] request, core, observed in
                do { return try completeObservation(request, core: core, observed: observed) }
                catch let failure as DriverKeyboardFault { throw fault(failure) }
            })
        }
    }
    private struct Pending {
        let event: DriverKeyboardEvent
        let modifier: String?
    }
    private static func update(_ pending: inout [Pending], _ spec: DriverKeyboardEvent) {
        let mod = order.first { modifiers[$0]!.0 == spec.keyCode }
        let down = spec.type == "keyDown" || spec.type == "flagsChanged" && mod != nil && spec.flags & modifiers[mod!]!.1 != 0
        if down {
            if !pending.contains(where: { $0.event.keyCode == spec.keyCode }) { pending.append(Pending(event: spec, modifier: mod)) }
        } else { pending.removeAll { $0.event.keyCode == spec.keyCode } }
    }
    private static func releases(_ pending: [Pending], preserving flags: UInt64 = 0, stop: Bool = false) -> [DriverKeyboardEvent] {
        var active = pending.compactMap { $0.modifier }, out = [DriverKeyboardEvent]()
        for key in pending.reversed() {
            if let mod = key.modifier { active.removeAll { $0 == mod } }
            let release = DriverKeyboardEvent(type: key.event.type == "flagsChanged" ? "flagsChanged" : "keyUp",
                keyCode: key.event.keyCode, flags: flags | Self.flags(active), unicode: key.event.unicode)
            out.append(release)
            if stop && release.type == "flagsChanged" {
                out.append(DriverKeyboardEvent(type: "keyUp", keyCode: release.keyCode, flags: release.flags, unicode: release.unicode))
            }
        }
        return out
    }
    func handle(_ request: DriverRequest, core: DriverCore) throws -> DriverObject {
        fallback = nil
        shortcutText = nil
        var sent = 0, uncertain = false, cleanupComplete = true
        var charactersDelivered: Int? = request.method == "typeText" ? 0 : nil
        var maxFakeActiveMs = 0.0
        var focusChanged = false, focusRestored = false
        var callFocus: DriverFocusSnapshot?
        var callStarted = focus?.providers.now() ?? 0
        var cleanup = [Send](), stopCleanup = [Send](), pid: Int32 = 0
        let inheritedHeld = held, inheritedBinding = heldBinding
        var survivingHeld = inheritedHeld
        var survivingRelease = [Send]()
        var unwound = false
        func unwind(stop: Bool = false) {
            guard !unwound else { return }; unwound = true
            // Cleanup uses only the original process identity. A recycled PID
            // never receives key ups intended for the dead process.
            if sent > 0 || uncertain {
                if let current = try? core.inventory.bound(request.params), driverInteger(current["pid"]) == Int(pid) {
                    for release in (stop ? stopCleanup : cleanup) { do { try release(pid); sent += 1 } catch { cleanupComplete = false } }
                } else { cleanupComplete = (stop ? stopCleanup : cleanup).isEmpty }
                if cleanupComplete { request.inputRelease?.clear("keyboard") }
                held = stop ? [] : survivingHeld; heldBinding = held.isEmpty ? nil : inheritedBinding
                if stop { heldRelease = nil }
                else if !held.isEmpty {
                    let retained = survivingRelease, originalPid = pid
                    heldRelease = {
                        let current = try core.inventory.bound(request.params)
                        guard driverInteger(current["pid"]) == Int(originalPid) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=release-pid") }
                        var failure: Error?
                        for send in retained { do { try send(originalPid) } catch { failure = failure ?? error } }
                        if let failure = failure { throw failure }
                    }
                    if let release = heldRelease {
                        do { try request.inputRelease?.retain("keyboard", release: release) } catch { cleanupComplete = false }
                    }
                } else { heldRelease = nil }
            }
        }
        do {
            try request.keys(["windowId", "processStart", "readId", "args"], optional: ["personToken"])
            guard let raw = request.params["args"] as? [Any] else { throw DriverFault("INVALID_PARAMS") }
            let args = try Self.parse(request.method, raw)
            if nativeTransport && core.inventory.fixture != nil { throw DriverKeyboardIssue("KEYBOARD_FIXTURE_REQUIRES_FAKE") }
            let strategy = ladder() ?? "flags-changed"
            guard ["flags-changed", "flags-only", "key-events"].contains(strategy) else { throw DriverFault("INVALID_PARAMS") }
            guard let windowId = request.params["windowId"] as? String, let start = request.params["processStart"] as? String,
                  let readId = driverInteger(request.params["readId"]), readId > 0,
                  request.params["personToken"] == nil || request.params["personToken"] is String else { throw DriverFault("INVALID_PARAMS") }
            let binding = windowId + ":" + start
            if !held.isEmpty && heldBinding != binding { throw DriverKeyboardIssue("MODIFIER_BINDING_CHANGED") }
            let bound = try core.boundWindow(request.params, request: request)
            request.actionEvent?.prepare(window: bound.window)
            guard let map = core.maps[windowId], map.id == readId, map.processStart == start else { throw DriverFault("STALE_READ") }
            guard bound.root.same(map.root) else { throw DriverFault("STALE_ELEMENT") }
            guard let value = driverInteger(bound.window["pid"]), value > 0, value <= Int(Int32.max) else { throw DriverFault("IDENTITY_UNVERIFIED") }
            pid = Int32(value)
            if request.method == "typeText" && !held.isEmpty { throw DriverKeyboardIssue("MODIFIERS_HELD") }
            var pending = held.map { Pending(event: DriverKeyboardEvent(type: "flagsChanged", keyCode: Self.modifiers[$0]!.0, flags: Self.flags(held)), modifier: $0) }
            // Cleanup owns only downs attempted by this call. Earlier holds
            // survive a refusal and are released only by an explicit up call.
            cleanup = []
            try beforeInput(request, core)
            callStarted = focus?.providers.now() ?? 0
            if request.method == "typeText", textBelief() == "fallback" {
                return try verifiedText(args.text!, request: request, core: core, window: bound.window, pid: pid)
            }
            try request.check()
            let needsLayout = request.method == "typeText" && !(args.text?.isEmpty ?? true) || request.method == "pressKey" && args.key != nil && Self.named[args.key!] == nil
            let currentLayout = needsLayout ? try layout() : [:]
            let specs = try Self.plan(request.method, args, layout: currentLayout, strategy: strategy, held: held)
            try Self.refuseClipboardKeys(specs, layout: currentLayout)
            try request.check()
            if request.method == "pressKey", args.key != nil, request.params["read"] as? String == "full", !map.truncated {
                shortcutText = map.text
            }
            if request.method == "pressKey", args.key != nil, held.isEmpty,
               !Self.undoChord(args, layout: currentLayout), request.params["read"] as? String == "full",
               !map.truncated, let text = map.text {
                try focus?.preflight()
                let previous = try focus?.providers.snapshot(request.remaining)
                do {
                    if let item = Self.singleMatch(try menuItems(request, core, pid), args: args, layout: currentLayout) {
                        try Self.refuseClipboardMenu(Self.menuAttributes(item), layout: currentLayout)
                        fallback = Fallback(args: args, layout: currentLayout, pid: pid, text: text,
                            focus: previous, menu: item, started: callStarted)
                    }
                } catch {
                    guard Self.menuReadFailure(error) else { throw error }
                }
            }
            var prefixes = [[Send]](), stopPrefixes = [[Send]](), posts = [Send]()
            // Prepare both ordinary events and every possible unwind before input.
            // An allocation failure therefore never leaves a half-built chord down.
            prefixes.append(cleanup)
            stopPrefixes.append(try Self.releases(pending, stop: true).map(makeEvent))
            var callPending = [Pending](), plannedHeld = inheritedHeld
            var inheritedPrefixes = [inheritedHeld], heldPrefixes = [[Send]]()
            heldPrefixes.append(try Self.releases(pending, stop: true).map(makeEvent))
            for spec in specs {
                try request.check()
                posts.append(try makeEvent(spec)); Self.update(&pending, spec)
                let inheritedCode = inheritedHeld.contains { Self.modifiers[$0]!.0 == spec.keyCode }
                if !inheritedCode { Self.update(&callPending, spec) }
                else if spec.type == "keyUp" || spec.type == "flagsChanged" && !inheritedHeld.contains(where: { Self.modifiers[$0]!.0 == spec.keyCode && spec.flags & Self.modifiers[$0]!.1 != 0 }) {
                    plannedHeld.removeAll { Self.modifiers[$0]!.0 == spec.keyCode }
                }
                inheritedPrefixes.append(plannedHeld)
                let remainingHeld = plannedHeld.map { Pending(event: DriverKeyboardEvent(type: "flagsChanged", keyCode: Self.modifiers[$0]!.0, flags: Self.flags(plannedHeld)), modifier: $0) }
                heldPrefixes.append(try Self.releases(remainingHeld, stop: true).map(makeEvent))
                prefixes.append(try Self.releases(callPending, preserving: Self.flags(plannedHeld)).map(makeEvent))
                stopPrefixes.append(try Self.releases(pending, stop: true).map(makeEvent))
            }
            cleanup = prefixes[0]; stopCleanup = stopPrefixes[0]; survivingRelease = heldPrefixes[0]
            let originalPid = pid
            var identity: () throws -> Void = {
                let current = try core.inventory.bound(request.params)
                guard driverInteger(current["pid"]) == Int(originalPid) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=keyboard-pid") }
            }
            var check = { [self] in try request.check(); try beforeInput(request, core); try request.check() }
            var next = 0
            // Only fake-active guards feed post costs. Keep measured transport,
            // pacing and cleanup costs across the call's intervals.
            var largestGuardMs = 0.0, largestPostMs = 0.0, largestPauseMs = 4.0, largestCleanupMs = 20.0
            var emptyRetries = 0, intervalCount = 0
            var intervalProjection: DriverObject = [:]
            if request.method == "typeText" { callFocus = try focus?.providers.snapshot(request.remaining) }
            func dispatch(_ guardInput: () throws -> Void, _ fakeActiveMs: () -> Double = { 0 }) throws -> DriverObject {
                let intervalFirst = next
                func guarded() throws {
                    let began = fakeActiveMs()
                    defer { largestGuardMs = max(largestGuardMs, fakeActiveMs() - began) }
                    try guardInput(); try request.check()
                }
                do {
                    while next < posts.count {
                        if request.method == "typeText", cleanup.isEmpty {
                            // One guard precedes each post. The final guard is
                            // reserved separately, followed by measured cleanup.
                            let strokeEnd = (next..<posts.count).first { prefixes[$0 + 1].isEmpty } ?? (posts.count - 1)
                            let postCount = strokeEnd - next + 1
                            let pauses = specs[next...strokeEnd].filter { $0.type == "keyUp" }.count
                            let estimatedKeyMs = Double(postCount) * (largestGuardMs + largestPostMs) + Double(pauses) * largestPauseMs
                            let projectedMs = fakeActiveMs() + estimatedKeyMs + largestGuardMs + largestCleanupMs
                            let yieldInterval = fakeActiveMs() > 0 && (fakeActiveMs() >= 200 || projectedMs >= 400)
                            intervalProjection = ["estimatedKeyMs": estimatedKeyMs, "projectedMs": projectedMs,
                                "cleanupReserveMs": largestCleanupMs, "finalGuardMs": largestGuardMs,
                                "strokePosts": postCount, "yielded": yieldInterval]
                            if yieldInterval {
                                if next == intervalFirst {
                                    guard emptyRetries < 1 else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=active-interval") }
                                    emptyRetries += 1
                                }
                                break
                            }
                        }
                        let index = next, post = posts[index]
                        try guarded()
                        let postStarted = fakeActiveMs()
                        // Track the attempted down before invoking a fallible transport.
                        try request.admitInput()
                        cleanup = prefixes[index + 1]; survivingHeld = inheritedPrefixes[index + 1]; survivingRelease = heldPrefixes[index + 1]; stopCleanup = stopPrefixes[index + 1]; uncertain = true
                        // Stop releases modifiers with reduced flagsChanged then
                        // explicit key-up. Ordinary unwind preserves its strategy.
                        let release = stopPrefixes[index] + stopPrefixes[index + 1]
                        let releaseInput = {
                            try identity()
                            var failure: Error?
                            for send in release { do { try send(originalPid) } catch { failure = failure ?? error } }
                            if let failure = failure { throw failure }
                        }
                        if let registry = request.inputRelease {
                            try registry.post("keyboard", release: releaseInput) { try post(originalPid) }
                            let retained = stopPrefixes[index + 1]
                            if retained.isEmpty { registry.clear("keyboard") }
                            else {
                                try registry.retain("keyboard") {
                                    try identity()
                                    var failure: Error?
                                    for send in retained { do { try send(originalPid) } catch { failure = failure ?? error } }
                                    if let failure = failure { throw failure }
                                }
                            }
                        } else { try post(originalPid) }
                        largestPostMs = max(largestPostMs, fakeActiveMs() - postStarted)
                        uncertain = false; sent += 1; next += 1
                        emptyRetries = 0
                        if request.method == "typeText" {
                            if specs[index].type == "keyDown" {
                                charactersDelivered! += specs[index].unicode?.unicodeScalars.count ?? 0
                            }
                            if specs[index].type == "keyUp" {
                                let began = fakeActiveMs(); pause()
                                largestPauseMs = max(largestPauseMs, fakeActiveMs() - began)
                            }
                        }
                        // Typing shares the next post's admission guard with
                        // this post's outcome. The final guard covers yield/end.
                        if request.method != "typeText" { try guarded() }
                    }
                    try guarded()
                    if request.method == "modifiers" {
                        held = args.state == "down" ? Self.sorted(held + args.keys) : held.filter { !args.keys.contains($0) }
                        heldBinding = held.isEmpty ? nil : binding
                        let release = stopCleanup
                        heldRelease = held.isEmpty ? nil : {
                            try identity()
                            var failure: Error?
                            for send in release {
                                do { try send(originalPid) } catch { if failure == nil { failure = error } }
                            }
                            if let failure = failure { throw failure }
                        }
                    }
                    var result: DriverObject = ["window": bound.window, "delivery": sent == 0 ? "not-sent" : "sent-unverified",
                            "retry": sent == 0 ? "safe" : "read-first", "personTookOver": false, "settled": false, "menuFallbackCount": 0]
                    if let count = charactersDelivered { result["charactersDelivered"] = count }
                    return result
                } catch {
                    // Admission can fail without a post. Preserve held modifiers
                    // and do not send cleanup for that refused action.
                    if request.inputAdmitted { unwind(stop: (error as? DriverFault)?.code == "USER_STOPPED") }
                    throw error
                }
            }
            if let focus = focus, !posts.isEmpty {
                var result: DriverObject = [:]
                repeat {
                    if let intervalGuards = intervalGuards {
                        let guards = try intervalGuards(request, core)
                        check = { try request.check(); try guards.check(); try request.check() }
                        identity = guards.identity
                    }
                    // Keep the first interval's owner identity across the call.
                    // A person switching apps between chunks is never a new baseline.
                    if intervalCount > 0 {
                        try check(); try identity(); try focus.preflight()
                        if focus.providers.personInputSince(callStarted) { throw DriverFault("PERSON_TOOK_OVER") }
                        if let previous = callFocus, !(try focus.providers.snapshot(request.remaining)).same(previous) {
                            focusChanged = true
                            throw DriverFault("PERSON_TOOK_OVER")
                        }
                    }
                    intervalProjection = [:]
                    intervalCount += 1
                    do {
                        result = try focus.run(pid: originalPid, check: check, identity: identity, remaining: { request.remaining },
                            guardCost: { largestGuardMs = max(largestGuardMs, $0) },
                            cleanupCost: { largestCleanupMs = max(largestCleanupMs, $0) },
                            cleanupReserve: { largestCleanupMs / 1000 },
                            projection: { intervalProjection },
                            admit: { try request.admitInput() }, body: dispatch)
                    } catch let failure as DriverFocusFault {
                        // A belief failure before all key posts can use the menu
                        // path only after cleanup proved safe. Never retry a chord
                        // whose transport may already have accepted a key.
                        guard failure.beliefUnconfirmed, fallback != nil, sent == 0, !uncertain,
                              cleanupComplete, !failure.unhealthy, !failure.focusChanged,
                              ["KEY_FOCUS_UNAVAILABLE", "AX_UNAVAILABLE"].contains((failure.cause as? DriverFault)?.code ?? "") else { throw failure }
                        fallback?.deliveryUnconfirmed = true
                        result = ["window": bound.window, "delivery": "not-sent", "retry": "safe",
                            "personTookOver": false, "settled": false, "menuFallbackCount": 0,
                            "focusChanged": failure.focusChanged, "focusRestored": failure.focusRestored,
                            "fakeActiveMs": failure.fakeActiveMs]
                        return result
                    }
                    maxFakeActiveMs = max(maxFakeActiveMs, result["fakeActiveMs"] as? Double ?? 0)
                    focusChanged = focusChanged || result["focusChanged"] as? Bool == true
                    focusRestored = focusRestored || result["focusRestored"] as? Bool == true
                    if next < posts.count && result["focusChanged"] as? Bool == true { throw DriverFault("PERSON_TOOK_OVER") }
                } while next < posts.count
                result["fakeActiveMs"] = maxFakeActiveMs
                result["focusChanged"] = focusChanged; result["focusRestored"] = focusRestored
                return result
            }
            return try dispatch({ try check(); try identity() })

        } catch {
            if let failure = error as? DriverKeyboardFault { throw failure }
            fallback = nil
            shortcutText = nil
            let focusFailure = error as? DriverFocusFault
            let cause = focusFailure?.cause ?? error
            let failure = cause as? DriverFault
            if !request.inputAdmitted, let failure = failure,
               failure.code == "CLIPBOARD_CHANGED" || failure.disposition["reason"] as? String == "clipboard-count-unavailable" {
                throw failure
            }
            unwind(stop: failure?.code == "USER_STOPPED")
            throw DriverKeyboardFault(code: failure?.code ?? (cause as? DriverKeyboardIssue)?.code ?? "KEYBOARD_INTERNAL",
                delivery: uncertain || !cleanupComplete ? "unknown" : sent == 0 ? "not-sent" : "sent-unverified",
                cleanupComplete: cleanupComplete, unhealthy: !cleanupComplete || (failure?.unhealthy ?? false) || focusFailure?.unhealthy == true,
                focusChanged: focusChanged || focusFailure?.focusChanged == true,
                focusRestored: focusRestored || focusFailure?.focusRestored == true,
                fakeActiveMs: max(maxFakeActiveMs, focusFailure?.fakeActiveMs ?? 0), charactersDelivered: charactersDelivered,
                personTookOver: driverBoolean(failure?.disposition["personTookOver"]), reason: failure?.disposition["reason"] as? String, message: ["KEY_FOCUS_UNAVAILABLE", "IDENTITY_CHANGED"].contains(failure?.code ?? "") ? failure?.message : nil)
        }
    }

    static func unicodeTextPlan(_ text: String) throws -> [DriverKeyboardEvent] {
        _ = try validText(text)
        guard !text.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\t" || $0 == "\r\n" }) else {
            throw DriverFault("ACTION_UNSUPPORTED")
        }
        var result = [DriverKeyboardEvent](), chunk = ""
        for scalar in text.unicodeScalars {
            let char = String(scalar)
            if chunk.utf16.count + char.utf16.count > 32 {
                result += stroke(0, [], unicode: chunk); chunk = ""
            }
            chunk += char
        }
        if !chunk.isEmpty { result += stroke(0, [], unicode: chunk) }
        return result
    }

    private func verifiedText(_ text: String, request: DriverRequest, core: DriverCore,
                              window: DriverObject, pid: Int32) throws -> DriverObject {
        var sent = 0, posted = 0, delivered = 0, uncertain = false, cleanupComplete = true
        var changed = false, restored = false, maxActiveMs = 0.0, beliefFallback = false, bypassed = false
        var originalOwner: DriverFocusSnapshot?, restorationUnhealthy = false
        let started = focus?.providers.now() ?? 0
        var release: Send?
        do {
            let specs = try Self.unicodeTextPlan(text)
            guard let focus = focus, let windowID = window["windowId"] as? String else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=text-context") }
            func identity() throws {
                let current = try core.inventory.bound(request.params)
                guard driverInteger(current["pid"]) == Int(pid) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=keyboard-pid") }
            }
            func basic() throws {
                try request.check(); try beforeInput(request, core); try request.check()
                try identity(); try focus.preflight()
                if focus.providers.personInputSince(started) { throw DriverFault("PERSON_TOOK_OVER") }
            }
            try basic()
            let owner = try focus.providers.snapshot(request.remaining)
            originalOwner = owner
            let target = try textSnapshot(pid, windowID, request.remaining, true)
            var baseline = target
            func guardInput() throws {
                try basic()
                if !(try focus.providers.snapshot(request.remaining)).same(owner) {
                    changed = true; throw DriverFault("PERSON_TOOK_OVER")
                }
                if !(try textSnapshot(pid, windowID, request.remaining, false)).sameTarget(target) {
                    changed = true; throw DriverFault("PERSON_TOOK_OVER")
                }
                try request.check()
            }
            try guardInput()
            bypassed = inputMethod()
            // Missing readback is detected before any post. It can select the
            // old belief mechanism, but an attempted Unicode chunk never can.
            beliefFallback = target.inserting("") == nil
            let posts = try specs.map(makeEvent)
            // Prepare all cleanup events before the first down, as for chords.
            let releases = try specs.filter { $0.type == "keyUp" }.map(makeEvent)
            var next = 0
            func dispatch(_ beliefGuard: () throws -> Void, _ activeMs: () -> Double) throws -> DriverObject {
                repeat {
                    try guardInput(); try beliefGuard()
                    // Verify the previous value and selection again immediately
                    // before the next down. A changed caret is not a new baseline.
                    if !beliefFallback, let value = baseline.value, let selection = baseline.selection {
                        let fresh = try textSnapshot(pid, windowID, request.remaining, true)
                        guard fresh.sameTarget(target), fresh.matches((value, selection)) else {
                            changed = true; throw DriverFault("PERSON_TOOK_OVER")
                        }
                    }
                    let index = next, chunk = specs[index].unicode!
                    try guardInput(); try beliefGuard(); try request.check()
                    try request.admitInput()
                    release = releases[index / 2]; uncertain = true
                    try posts[index](pid); uncertain = false; sent += 1; posted += chunk.unicodeScalars.count
                    try guardInput(); try beliefGuard(); try request.check()
                    try request.admitInput(); uncertain = true
                    try posts[index + 1](pid); uncertain = false; sent += 1; release = nil; next += 2
                    pause()
                    try guardInput(); try beliefGuard()
                    if beliefFallback { delivered = posted }
                    else {
                        guard let expected = baseline.inserting(chunk) else { throw DriverFault("ACTION_UNCONFIRMED") }
                        let until = focus.providers.now() + min(0.15, request.remaining)
                        var after = baseline
                        while true {
                            try guardInput(); try beliefGuard()
                            after = try textSnapshot(pid, windowID, request.remaining, true)
                            guard after.sameTarget(target) else { changed = true; throw DriverFault("PERSON_TOOK_OVER") }
                            if after.matches(expected) { break }
                            guard focus.providers.now() < until else { break }
                            focus.providers.pause(min(0.01, max(0, until - focus.providers.now())))
                        }
                        guard after.matches(expected) else {
                            // A length-limited field may prove a strict prefix.
                            // Neither that prefix nor an unchanged value grants
                            // permission to resend the remainder of this chunk.
                            var prefix = "", count = 0
                            for scalar in chunk.unicodeScalars {
                                prefix += String(scalar); count += 1
                                if let partial = baseline.inserting(prefix), after.matches(partial) { delivered += count; break }
                            }
                            throw DriverFault("ACTION_UNCONFIRMED")
                        }
                        delivered += chunk.unicodeScalars.count; baseline = after
                    }
                    if activeMs() >= 200 { break }
                } while next < posts.count
                return [:]
            }
            if !posts.isEmpty {
                if beliefFallback {
                    repeat {
                        try guardInput()
                        let result = try focus.run(pid: pid, check: guardInput, identity: identity,
                            remaining: { request.remaining }, admit: { try request.admitInput() }, body: dispatch)
                        maxActiveMs = max(maxActiveMs, result["fakeActiveMs"] as? Double ?? 0)
                        changed = changed || result["focusChanged"] as? Bool == true
                        restored = restored || result["focusRestored"] as? Bool == true
                        if changed && next < posts.count { throw DriverFault("PERSON_TOOK_OVER") }
                    } while next < posts.count
                } else { _ = try dispatch({}, { 0 }) }
            }
            return ["window": window, "delivery": sent == 0 ? "not-sent" : beliefFallback ? "sent-unverified" : "sent-verified",
                "retry": sent == 0 ? "safe" : "read-first", "settled": false, "personTookOver": false,
                "focusChanged": changed, "focusRestored": restored, "fakeActiveMs": maxActiveMs, "menuFallbackCount": 0,
                "charactersDelivered": delivered, "charactersPosted": posted,
                "compositionBypassed": bypassed, "textBeliefFallback": beliefFallback]
        } catch {
            let focusFailure = error as? DriverFocusFault
            let cause = focusFailure?.cause ?? error
            let fault = cause as? DriverFault
            if !request.inputAdmitted, let fault = fault,
               fault.code == "CLIPBOARD_CHANGED" || fault.disposition["reason"] as? String == "clipboard-count-unavailable" { throw fault }
            if let release = release {
                // A failed down may already have been accepted. Release only,
                // and only while the original process still owns the binding.
                if let current = try? core.inventory.bound(request.params), driverInteger(current["pid"]) == Int(pid) {
                    do { try release(pid) } catch { cleanupComplete = false }
                } else { cleanupComplete = false }
            }
            if !beliefFallback, let owner = originalOwner, let focus = focus, sent > 0 || uncertain {
                do {
                    let final = try focus.restoreAfterAction(owner, pid: pid, started: started, attempted: true, budget: request.remaining)
                    changed = changed || final.changed; restored = final.restored
                    restorationUnhealthy = final.snapshotFailed
                } catch { restorationUnhealthy = true }
            }
            throw DriverKeyboardFault(code: fault?.code ?? (cause as? DriverKeyboardIssue)?.code ?? "KEYBOARD_INTERNAL",
                delivery: uncertain || !cleanupComplete ? "unknown" : sent == 0 ? "not-sent" : "sent-unverified",
                cleanupComplete: cleanupComplete, unhealthy: !cleanupComplete || restorationUnhealthy || fault?.unhealthy == true || focusFailure?.unhealthy == true,
                focusChanged: changed || focusFailure?.focusChanged == true,
                focusRestored: restored || focusFailure?.focusRestored == true,
                fakeActiveMs: max(maxActiveMs, focusFailure?.fakeActiveMs ?? 0), charactersDelivered: delivered,
                personTookOver: driverBoolean(fault?.disposition["personTookOver"]), reason: fault?.disposition["reason"] as? String,
                charactersPosted: posted, compositionBypassed: bypassed, textBeliefFallback: beliefFallback, message: ["KEY_FOCUS_UNAVAILABLE", "IDENTITY_CHANGED"].contains(fault?.code ?? "") ? fault?.message : nil)
        }
    }

    static func systemInputMethod() -> Bool {
        guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
              let type = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return false }
        return CFEqual(Unmanaged<CFString>.fromOpaque(type).takeUnretainedValue(), kTISTypeKeyboardInputMode)
    }

    static func systemTextSnapshot(_ pid: Int32, _ windowID: String, _ budget: Double, _ includeValue: Bool) throws -> DriverTextSnapshot {
        try sampleTextSnapshot(pid, windowID, budget, includeValue, access: .system)
    }
    static func sampleTextSnapshot(_ pid: Int32, _ windowID: String, _ budget: Double, _ includeValue: Bool,
                                   access: DriverTextAccess) throws -> DriverTextSnapshot {
        let until = ProcessInfo.processInfo.systemUptime + budget
        func copy(_ element: CFTypeRef, _ name: String) throws -> CFTypeRef? {
            let remaining = until - ProcessInfo.processInfo.systemUptime
            guard remaining.isFinite, remaining > 0 else { throw DriverFault("DEADLINE_EXCEEDED") }
            return try access.copy(element, name, remaining)
        }
        func element(_ value: CFTypeRef?) throws -> CFTypeRef {
            guard let value = value, access.isElement(value) else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=text-element") }
            return value
        }
        let app = access.application(pid)
        let field = try element(copy(app, kAXFocusedUIElementAttribute))
        var current = field, found: CFTypeRef?
        for depth in 0..<66 {
            guard access.pid(current) == pid else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=keyboard-field-pid") }
            let role = try copy(current, kAXRoleAttribute) as? String
            let subrole = try copy(current, kAXSubroleAttribute) as? String
            guard let role = role else { throw DriverFault("AX_UNAVAILABLE") }
            if role == "AXSecureTextField" || subrole == "AXSecureTextField" { throw DriverFault("SECURE_FIELD") }
            if depth == 0 {
                guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role),
                      driverBoolean(try copy(current, kAXEnabledAttribute)) == true else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=text-role") }
            }
            if role == kAXWindowRole {
                guard let number = driverInteger(try copy(current, "AXWindowNumber")), String(number) == windowID else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=text-window") }
                found = current; break
            }
            current = try element(copy(current, kAXParentAttribute))
        }
        guard let window = found else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=text-ancestry") }
        guard includeValue else { return DriverTextSnapshot(element: field, window: window, value: nil, selection: nil) }
        // Refuse oversized readback before requesting value when a count exists.
        if let count = driverInteger(try copy(field, kAXNumberOfCharactersAttribute)), count > 1_048_576 {
            return DriverTextSnapshot(element: field, window: window, value: nil, selection: nil)
        }
        let value = try copy(field, kAXValueAttribute) as? String
        var selected: NSRange?
        if let raw = try copy(field, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            var range = CFRange()
            guard AXValueGetType(raw as! AXValue) == .cfRange, AXValueGetValue(raw as! AXValue, .cfRange, &range),
                  range.location >= 0, range.length >= 0 else { throw DriverFault("AX_UNAVAILABLE") }
            selected = NSRange(location: range.location, length: range.length)
        }
        let bounded = value.flatMap { $0.utf16.count <= 1_048_576 ? $0 : nil }
        return DriverTextSnapshot(element: field, window: window, value: bounded, selection: selected)
    }

    static func safetyKeyCodes(_ layout: [String: DriverKeyboardMapping], characters: Set<String>, physical: Set<Int>) -> Set<Int> {
        var codes = physical
        for (character, mapping) in layout {
            if (!mapping.modifiers.contains("alt") && characters.contains(character)) ||
                mapping.safetyCharacters.contains(where: { characters.contains($0) }) {
                codes.insert(mapping.keyCode)
            }
        }
        return codes
    }
    static func clipboardKeyCodes(_ layout: [String: DriverKeyboardMapping]) -> Set<Int> {
        safetyKeyCodes(layout, characters: ["c", "C", "x", "X"], physical: [8, 7])
    }
    static let clipboardMenuAttributes = [kAXRoleAttribute, kAXMenuItemCmdCharAttribute,
        kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdModifiersAttribute, kAXTitleAttribute, kAXDescriptionAttribute]
    static func menuAttributes(_ item: DriverKeyboardMenuItem) -> DriverObject {
        var attrs: DriverObject = [kAXRoleAttribute: kAXMenuItemRole, kAXTitleAttribute: item.title ?? ""]
        attrs[kAXMenuItemCmdCharAttribute] = item.character
        attrs[kAXMenuItemCmdVirtualKeyAttribute] = item.virtualKey
        attrs[kAXMenuItemCmdModifiersAttribute] = item.modifiers
        return attrs
    }
    static func validateMenuAttributes(_ current: DriverObject, original: DriverObject) throws {
        guard NSDictionary(dictionary: current).isEqual(to: original) else { throw DriverFault("STALE_ELEMENT") }
    }
    // Advisory title layer. Menu equivalents and planned codes are independent
    // of these finite words. The list matches the parent's existing 26 entries.
    private static let clipboardCamel = try! NSRegularExpression(pattern: "([a-z]{2,})([A-Z])")
    private static let clipboardIgnorable = try! NSRegularExpression(pattern: "[\\p{Cf}\\p{Default_Ignorable_Code_Point}]")
    private static let clipboardSpacing = try! NSRegularExpression(pattern: "[\\p{Z}\\p{Pd}_\\s\\u2212]+")
    private static let clipboardWords = try! NSRegularExpression(pattern:
        "(?<![\\p{L}\\p{N}])(?:copy|cut|copiar|cortar|copier|couper|kopieren|ausschneiden|recortar|copia|copiare|taglia|tagliare)(?![\\p{L}\\p{N}])|コピー|切り取り|切取|复制|複製|拷贝|拷貝|剪切|剪下|복사|잘라내기")
    private static let clipboardLocale = Locale(identifier: "en_US_POSIX")
    private static func clipboardReplace(_ pattern: NSRegularExpression, _ text: String, _ template: String) -> String {
        pattern.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: text.utf16.count), withTemplate: template)
    }
    static func refuseClipboardLabel(_ title: String) throws {
        let camel = clipboardReplace(clipboardCamel, title, "$1 $2")
        let folded = camel.precomposedStringWithCompatibilityMapping
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: clipboardLocale)
        let visible = clipboardReplace(clipboardIgnorable, folded, "")
        let label = clipboardReplace(clipboardSpacing, visible, " ")
        if clipboardWords.firstMatch(in: label, range: NSRange(location: 0, length: label.utf16.count)) != nil {
            throw clipboardRefusal()
        }
    }
    static func refuseClipboardEquivalent(_ attrs: DriverObject, layout: [String: DriverKeyboardMapping]? = nil) throws {
        // Missing, unsupported or unreadable modifiers cannot prove NoCommand.
        let mods = driverInteger(attrs[kAXMenuItemCmdModifiersAttribute]) ?? 0
        guard mods & 8 == 0 else { return }
        let char = attrs[kAXMenuItemCmdCharAttribute] as? String ?? ""
        if ["c", "C", "x", "X"].contains(char) { throw clipboardRefusal() }
        if let code = driverInteger(attrs[kAXMenuItemCmdVirtualKeyAttribute]) {
            if [8, 7].contains(code) { throw clipboardRefusal() }
            if try clipboardKeyCodes(layout ?? systemLayout()).contains(code) { throw clipboardRefusal() }
        }
    }
    static func refuseClipboardMenu(_ attrs: DriverObject, layout: [String: DriverKeyboardMapping]? = nil, checkLabels: Bool = true) throws {
        if attrs[kAXRoleAttribute] as? String == kAXMenuItemRole { try refuseClipboardEquivalent(attrs, layout: layout) }
        guard checkLabels else { return }
        for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let title = attrs[name] as? String { try refuseClipboardLabel(title) }
        }
    }
    static func clipboardRefusal() -> DriverFault {
        var fault = DriverFault("ACTION_UNSUPPORTED")
        fault.disposition = ["delivery": "not-sent", "retry": "safe", "clipboard": "untouched"]
        return fault
    }
    static func refuseClipboardKeys(_ specs: [DriverKeyboardEvent], layout: [String: DriverKeyboardMapping]) throws {
        let copy = clipboardKeyCodes(layout)
        let paste = safetyKeyCodes(layout, characters: ["v", "V"], physical: [9])
        let quit = safetyKeyCodes(layout, characters: ["q", "Q"], physical: [12])
        let modifierCodes = Set(modifiers.values.map { $0.0 })
        for spec in specs where spec.type == "keyDown" && !modifierCodes.contains(spec.keyCode) {
            let command = spec.flags & 0x100000 != 0
            let control = spec.flags & 0x40000 != 0
            let controlOnly = control && spec.flags & 0x180000 == 0 // Shift may accompany Control; Command and Option may not.
            if (command || control) && (copy.contains(spec.keyCode) && !controlOnly || paste.contains(spec.keyCode)) ||
                command && spec.flags & 0x20000 != 0 && [20, 21, 22, 23].contains(spec.keyCode) {
                throw clipboardRefusal()
            }
            if command && (quit.contains(spec.keyCode) || spec.keyCode == 53 && spec.flags & 0x80000 != 0) {
                throw DriverFault("ACTION_UNSUPPORTED")
            }
        }
    }
    private static func undoChord(_ args: Arguments, layout: [String: DriverKeyboardMapping]) -> Bool {
        guard args.key?.lowercased() == "z", let map = try? mapping(args.key!, layout) else { return false }
        let keys = Set(args.keys + map.modifiers)
        return keys == Set(["meta"]) || keys == Set(["meta", "shift"])
    }
    private static func menuReadFailure(_ error: Error) -> Bool {
        guard let code = (error as? DriverFault)?.code else { return false }
        return ["AX_UNAVAILABLE", "IDENTITY_CHANGED"].contains(code)
    }
    private static func singleMatch(_ items: [DriverKeyboardMenuItem], args: Arguments,
                                    layout: [String: DriverKeyboardMapping]) -> DriverKeyboardMenuItem? {
        let candidates = items.filter { !$0.metadataValid || matches($0, args: args, layout: layout) }
        guard candidates.count == 1, candidates[0].metadataValid, candidates[0].enabled else { return nil }
        return candidates[0]
    }
    static func matches(_ item: DriverKeyboardMenuItem, args: Arguments, layout: [String: DriverKeyboardMapping]) -> Bool {
        guard item.metadataValid, let key = args.key, let mods = item.modifiers, mods >= 0, mods <= 15,
              let map = try? mapping(key, layout) else { return false }
        let keys = Set(args.keys + map.modifiers)
        let expected = (keys.contains("shift") ? 1 : 0) | (keys.contains("alt") ? 2 : 0) |
            (keys.contains("control") ? 4 : 0) | (keys.contains("meta") ? 0 : 8)
        guard mods == expected else { return false }
        // Empty character plus null glyph denotes no usable equivalent. Zero
        // alone is also ambiguous with the virtual code for A on some layouts.
        if item.character == "" && (item.glyph ?? 0) == 0 { return false }
        if item.virtualKey == 0 && (item.character ?? "").isEmpty && (item.glyph ?? 0) == 0 { return false }
        var evidence = false
        if let char = item.character, !char.isEmpty {
            var characters = ["Return": "\r", "KP_Enter": "\u{3}", "Tab": "\t", "Space": " ", "Escape": "\u{1b}", "BackSpace": "\u{7f}"]
            for (name, value) in [("Up", NSUpArrowFunctionKey), ("Down", NSDownArrowFunctionKey), ("Left", NSLeftArrowFunctionKey),
                ("Right", NSRightArrowFunctionKey), ("Home", NSHomeFunctionKey), ("End", NSEndFunctionKey),
                ("PageUp", NSPageUpFunctionKey), ("PageDown", NSPageDownFunctionKey), ("Delete", NSDeleteFunctionKey)] {
                characters[name] = String(UnicodeScalar(UInt32(value))!)
            }
            for number in 1...20 { characters["F\(number)"] = String(UnicodeScalar(UInt32(NSF1FunctionKey) + UInt32(number - 1))!) }
            let expectedChar = characters[key] ?? key
            let asciiLetter = { (text: String) in
                text.utf8.count == 1 && text.utf8.allSatisfy { (65...90).contains($0) || (97...122).contains($0) }
            }
            guard char.unicodeScalars.count == 1,
                  char == expectedChar || asciiLetter(char) && asciiLetter(expectedChar) && char.lowercased() == expectedChar.lowercased() else { return false }
            evidence = true
        }
        if let code = item.virtualKey {
            guard (0...127).contains(code), code == map.keyCode else { return false }; evidence = true
        }
        if let glyph = item.glyph, glyph != 0 {
            // Delete glyphs describe direction (including RTL), not a unique
            // physical key. Require character or virtual-key evidence as well.
            if glyph == Int(kMenuDeleteLeftGlyph) || glyph == Int(kMenuDeleteRightGlyph) {
                guard [51, 117].contains(map.keyCode), evidence else { return false }
                return true
            }
            var codes = [Int(kMenuEscapeGlyph): 53, Int(kMenuReturnGlyph): 36, Int(kMenuReturnR2LGlyph): 36,
                Int(kMenuEnterGlyph): 76, Int(kMenuTabRightGlyph): 48, Int(kMenuTabLeftGlyph): 48,
                Int(kMenuSpaceGlyph): 49,
                Int(kMenuPageUpGlyph): 116, Int(kMenuPageDownGlyph): 121,
                Int(kMenuLeftArrowGlyph): 123, Int(kMenuRightArrowGlyph): 124, Int(kMenuDownArrowGlyph): 125, Int(kMenuUpArrowGlyph): 126]
            for number in 1...12 { codes[Int(kMenuF1Glyph) + number - 1] = named["F\(number)"] }
            for number in 13...15 { codes[Int(kMenuF13Glyph) + number - 13] = named["F\(number)"] }
            for number in 16...19 { codes[Int(kMenuF16Glyph) + number - 16] = named["F\(number)"] }
            guard codes[glyph] == map.keyCode else { return false }; evidence = true
        }
        return evidence
    }
    func completeObservation(_ request: DriverRequest, core: DriverCore, observed: DriverObject) throws -> DriverObject {
        let candidate = fallback; fallback = nil
        let previousText = shortcutText; shortcutText = nil
        func noPress() throws -> DriverObject {
            guard candidate?.deliveryUnconfirmed == true else { return observed }
            throw DriverKeyboardFault(code: observed["personTookOver"] as? Bool == true ? "PERSON_TOOK_OVER" : "KEY_FOCUS_UNAVAILABLE",
                delivery: "not-sent", cleanupComplete: true,
                unhealthy: false, focusChanged: observed["focusChanged"] as? Bool == true,
                focusRestored: observed["focusRestored"] as? Bool == true,
                fakeActiveMs: observed["fakeActiveMs"] as? Double ?? 0,
                message: observed["personTookOver"] as? Bool == true ? nil : "KEY_FOCUS_UNAVAILABLE step=menu-fallback")
        }
        guard let previousText = previousText, request.method == "pressKey", request.params["read"] as? String == "full",
              observed["settled"] as? Bool == true, observed["reason"] as? String == "quiet",
              observed["focusChanged"] as? Bool != true,
              observed["personTookOver"] as? Bool != true, observed["truncated"] as? Bool == false,
              observed["text"] as? String == previousText else { return try noPress() }
        if observed["delivery"] as? String == "sent-unverified" {
            var result = observed
            result["note"] = "shortcut delivered with no visible change"
            return result
        }
        guard let candidate = candidate, candidate.deliveryUnconfirmed, previousText == candidate.text else { return try noPress() }
        var changed = false, restored = false, pressing = false, pressed = false, unhealthy = false
        var result = observed, failure: Error?
        let started = candidate.started
        do {
            func guardMenu() throws {
                try request.check(); try beforeInput(request, core); try request.check(); try focus?.preflight()
                let current = try core.inventory.bound(request.params)
                guard driverInteger(current["pid"]) == Int(candidate.pid) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=keyboard-pid") }
                if let previous = candidate.focus, let focus = focus, !(try focus.providers.snapshot(request.remaining)).same(previous) {
                    changed = true; throw DriverFault("PERSON_TOOK_OVER")
                }
            }
            try guardMenu()
            guard let item = Self.singleMatch(try menuItems(request, core, candidate.pid), args: candidate.args, layout: candidate.layout),
                  item.title == candidate.menu.title, item.mark == candidate.menu.mark,
                  item.enabled == candidate.menu.enabled else { return try noPress() }
            try Self.refuseClipboardMenu(Self.menuAttributes(item), layout: candidate.layout)
            try item.press(candidate.pid) {
                try guardMenu(); try request.admitInput(); pressing = true
            }
            pressed = true
            // The returned tree must follow the AX press. Do not return the quiet
            // pre-fallback tree as though it observed this second action.
            let binding: DriverObject = ["windowId": request.params["windowId"]!, "processStart": request.params["processStart"]!]
            result.merge(try core.readTree(binding, request: request)) { _, new in new }
            result["settled"] = false; result["menuFallbackCount"] = 1; result["note"] = "pressed the matching menu item"
            result.removeValue(forKey: "reason")
            result["delivery"] = "sent-unverified"; result["retry"] = "read-first"
        } catch {
            if let failure = error as? DriverKeyboardFault { throw failure }
            if !pressing && Self.menuReadFailure(error) { return try noPress() }
            failure = error
        }
        if pressing, let previous = candidate.focus, let focus = focus {
            do {
                let final = try focus.restoreAfterAction(previous, pid: candidate.pid, started: started, attempted: true, budget: request.remaining)
                changed = changed || final.changed; restored = final.restored
                if final.snapshotFailed { unhealthy = true; if failure == nil { failure = DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=restore") } }
            } catch { unhealthy = true; if failure == nil { failure = error } }
        }
        if let failure = failure {
            let coreFailure = failure as? DriverFault
            throw DriverKeyboardFault(code: coreFailure?.code ?? "KEYBOARD_INTERNAL",
                delivery: pressing ? "unknown" : observed["delivery"] as? String ?? "sent-unverified", cleanupComplete: true,
                unhealthy: unhealthy || coreFailure?.unhealthy == true,
                focusChanged: changed || observed["focusChanged"] as? Bool == true,
                focusRestored: restored || observed["focusRestored"] as? Bool == true,
                fakeActiveMs: observed["fakeActiveMs"] as? Double ?? 0,
                menuFallbackCount: pressing ? 1 : 0,
                menuNote: pressing ? (pressed ? "pressed the matching menu item" : "matching menu item press was attempted") : nil,
                personTookOver: driverBoolean(coreFailure?.disposition["personTookOver"]), reason: coreFailure?.disposition["reason"] as? String, message: ["KEY_FOCUS_UNAVAILABLE", "IDENTITY_CHANGED"].contains(coreFailure?.code ?? "") ? coreFailure?.message : nil)
        }
        result["focusChanged"] = changed || observed["focusChanged"] as? Bool == true
        result["focusRestored"] = restored || observed["focusRestored"] as? Bool == true
        return result
    }

    static func systemMenuItems(_ request: DriverRequest, pid: Int32) throws -> [DriverKeyboardMenuItem] {
        func copy(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
            try request.check(); AXUIElementSetMessagingTimeout(element, Float(min(0.01, request.remaining)))
            var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
            if status == .noValue || status == .attributeUnsupported { return nil }
            guard status == .success else { throw DriverFault("AX_UNAVAILABLE") }
            return value
        }
        let app = AXUIElementCreateApplication(pid)
        guard let value = try copy(app, kAXMenuBarAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return [] }
        var stack: [(AXUIElement, Int)] = [(value as! AXUIElement, 0)], count = 0, result = [DriverKeyboardMenuItem]()
        let names = [kAXMenuItemCmdCharAttribute, kAXMenuItemCmdVirtualKeyAttribute, kAXMenuItemCmdModifiersAttribute, kAXMenuItemCmdGlyphAttribute, kAXTitleAttribute, kAXMenuItemMarkCharAttribute]
        while let (element, depth) = stack.popLast() {
            count += 1; guard count <= 3000, depth <= 64 else { throw DriverFault("AX_UNAVAILABLE") }
            guard let role = try copy(element, kAXRoleAttribute) as? String else { throw DriverFault("AX_UNAVAILABLE") }
            if role == kAXMenuItemRole {
                var attrs: DriverObject = [:]
                for name in names { attrs[name] = try copy(element, name) }
                let enabled = try copy(element, kAXEnabledAttribute)
                result.append(DriverKeyboardMenuItem(attributes: attrs, enabled: enabled, press: { expected, beforePress in
                        var actual: pid_t = 0
                        guard AXUIElementGetPid(element, &actual) == .success, actual == expected,
                              try copy(element, kAXRoleAttribute) as? String == kAXMenuItemRole,
                              DriverKeyboardMenuItem.enabledValue(try copy(element, kAXEnabledAttribute)) else { throw DriverFault("STALE_ELEMENT") }
                        var current: DriverObject = [:]
                        for name in names { current[name] = try copy(element, name) }
                        try Self.validateMenuAttributes(current, original: attrs)
                        try beforePress(); try request.check()
                        guard AXUIElementPerformAction(element, kAXPressAction as CFString) == .success else { throw DriverFault("ACTION_UNCONFIRMED") }
                    }))
            }
            if let value = try copy(element, kAXChildrenAttribute) {
                guard CFGetTypeID(value) == CFArrayGetTypeID(), let children = value as? [AXUIElement] else { throw DriverFault("AX_UNAVAILABLE") }
                guard stack.count + count + children.count <= 3000 else { throw DriverFault("AX_UNAVAILABLE") }
                for child in children.reversed() { stack.append((child, depth + 1)) }
            }
        }
        return result
    }

    static func systemLayout() throws -> [String: DriverKeyboardMapping] {
        // The selected layout, including the underlying layout for an IME. Never
        // substitute a US table or switch the person's input source.
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { throw DriverKeyboardIssue("KEYBOARD_LAYOUT_UNAVAILABLE") }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard CFDataGetLength(data) >= MemoryLayout<UCKeyboardLayout>.size, let bytes = CFDataGetBytePtr(data) else { throw DriverKeyboardIssue("KEYBOARD_LAYOUT_UNAVAILABLE") }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        return withExtendedLifetime(data) {
            let keyboardType = UInt32(LMGetKbdType())
            return layoutMappings { code, carbon in
                var dead: UInt32 = 0, length = 0, chars = [UniChar](repeating: 0, count: 8)
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), carbon >> 8,
                    keyboardType, OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
                if status == noErr, length > 0, length <= chars.count, dead == 0 {
                    return String(utf16CodeUnits: chars, count: length)
                }
                return nil
            }
        }
    }
    // The same injected translator builds fixture and system layouts. The first
    // four states retain the typing map; Command states add safety evidence only.
    static func layoutMappings(translate: (Int, UInt32) -> String?) -> [String: DriverKeyboardMapping] {
        var result = [String: DriverKeyboardMapping]()
        for mods: [String] in [[], ["shift"], ["alt"], ["alt", "shift"], ["meta"], ["meta", "shift"]] {
            let carbon = (mods.contains("shift") ? UInt32(shiftKey) : 0) |
                (mods.contains("alt") ? UInt32(optionKey) : 0) | (mods.contains("meta") ? UInt32(cmdKey) : 0)
            for code in 0...127 {
                guard let text = translate(code, carbon), text.unicodeScalars.count == 1,
                      let scalar = text.unicodeScalars.first, scalar.value >= 32,
                      !CharacterSet.controlCharacters.contains(scalar) else { continue }
                if !mods.contains("meta"), result[text] == nil { result[text] = DriverKeyboardMapping(keyCode: code, modifiers: mods) }
                if !mods.contains("alt"), ["c", "C", "x", "X", "v", "V", "q", "Q"].contains(text) {
                    result["\u{0}guard:\(code):\(carbon)"] = DriverKeyboardMapping(keyCode: code, modifiers: [], safetyCharacters: [text])
                }
            }
        }
        return result
    }
    static func systemCGEvent(_ spec: DriverKeyboardEvent, source: CGEventSource) throws -> CGEvent {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(spec.keyCode), keyDown: spec.type != "keyUp") else { throw DriverKeyboardIssue("EVENT_CREATE_FAILED") }
        event.type = spec.type == "flagsChanged" ? .flagsChanged : spec.type == "keyDown" ? .keyDown : .keyUp
        event.flags = CGEventFlags(rawValue: spec.flags)
        event.setIntegerValueField(.keyboardEventAutorepeat, value: 0)
        event.setIntegerValueField(.keyboardEventKeyboardType, value: Int64(LMGetKbdType()))
        if let text = spec.unicode {
            let units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        return event
    }
    static func systemEvent(_ spec: DriverKeyboardEvent, source: CGEventSource) throws -> Send {
        let event = try systemCGEvent(spec, source: source)
        return { pid in
            event.timestamp = DispatchTime.now().uptimeNanoseconds
            event.postToPid(pid)
        }
    }
}
