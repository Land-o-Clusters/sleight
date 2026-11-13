import AppKit
import ApplicationServices

// DriverMain owns an inert semantic adapter while its methods remain disabled.
var driverSemanticAdapter: DriverSemantic?

// Inert until explicitly registered. The caller supplies the same lease/person guard
// used by pointer and keyboard input. No model parameter can supply that guard.
struct DriverSemanticAccess {
    var attributes: (DriverNode, [String], DriverRequest) throws -> DriverObject
    var isSettable: (DriverNode, String, DriverRequest) throws -> Bool
    var set: (DriverNode, String, Any, DriverRequest) throws -> Void
    var actionNames: (DriverNode, DriverRequest) throws -> [String]
    var secondaryActions: (DriverNode, DriverRequest) throws -> [(label: String, action: String)]
    var perform: (DriverNode, String, DriverRequest) throws -> Void
    var parent: (DriverNode, DriverRequest) throws -> DriverNode?
    var children: (DriverNode, DriverRequest) throws -> [DriverNode]
    var focused: (DriverBoundWindow, DriverRequest) throws -> DriverNode?

    static var system: DriverSemanticAccess {
        DriverSemanticAccess(attributes: { node, names, request in
            var attrs = try node.attributes(names, request: request)
            if let raw = attrs[kAXSelectedTextRangeAttribute], CFGetTypeID(raw as CFTypeRef) == AXValueGetTypeID() {
                var range = CFRange()
                guard AXValueGetType(raw as! AXValue) == .cfRange,
                      AXValueGetValue(raw as! AXValue, .cfRange, &range) else { throw DriverFault("AX_UNAVAILABLE") }
                attrs[kAXSelectedTextRangeAttribute] = [range.location, range.length]
            }
            return attrs
        }, isSettable: { try $0.settable($1, request: $2) }, set: { node, name, value, request in
            try node.timeout(request)
            guard let ax = node.ax else { throw DriverFault("ACTION_UNSUPPORTED") }
            let raw: CFTypeRef
            if name == kAXSelectedTextRangeAttribute, let pair = value as? [Int], pair.count == 2 {
                var range = CFRange(location: pair[0], length: pair[1])
                guard let wrapped = AXValueCreate(.cfRange, &range) else { throw DriverFault("AX_UNAVAILABLE") }
                raw = wrapped
            } else { raw = value as CFTypeRef }
            let status = AXUIElementSetAttributeValue(ax, name as CFString, raw)
            if status == .invalidUIElement { throw DriverFault("STALE_ELEMENT") }
            guard status == .success else { throw DriverFault("ACTION_UNCONFIRMED") }
        }, actionNames: { node, request in
            try node.timeout(request)
            guard let ax = node.ax else { throw DriverFault("ACTION_UNSUPPORTED") }
            var names: CFArray?
            guard AXUIElementCopyActionNames(ax, &names) == .success, let result = names as? [String] else { throw DriverFault("AX_UNAVAILABLE") }
            return result
        }, secondaryActions: { try $0.secondaryActions($1) }, perform: { node, name, request in
            try node.timeout(request)
            guard let ax = node.ax else { throw DriverFault("ACTION_UNSUPPORTED") }
            let status = AXUIElementPerformAction(ax, name as CFString)
            if status == .invalidUIElement { throw DriverFault("STALE_ELEMENT") }
            guard status == .success else { throw DriverFault("ACTION_UNCONFIRMED") }
        }, parent: { node, request in
            let attrs = try node.attributes([kAXParentAttribute], request: request)
            guard let raw = attrs[kAXParentAttribute], CFGetTypeID(raw as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
            return DriverNode(raw as! AXUIElement)
        }, children: { node, request in
            let (children, truncated) = try node.children(request, limit: 256)
            guard !truncated else { throw DriverFault("ACTION_UNSUPPORTED") }
            return children
        }, focused: { bound, request in
            guard bound.root.ax != nil, let pid = driverInteger(bound.window["pid"]) else { return nil }
            let app = DriverNode(AXUIElementCreateApplication(pid_t(pid)))
            let attrs = try app.attributes([kAXFocusedUIElementAttribute], request: request)
            guard let raw = attrs[kAXFocusedUIElementAttribute], CFGetTypeID(raw as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
            return DriverNode(raw as! AXUIElement)
        })
    }
}

final class DriverSemantic {
    typealias Guard = (DriverRequest, DriverCore) throws -> Void
    static let methods = ["setValue", "selectText", "performSecondaryAction", "paste"]
    static let textLimit = 1_048_576
    private let access: DriverSemanticAccess
    private let beforeInput: Guard
    typealias Qualification = (DriverBoundWindow, DriverElement, DriverStrictTextPath, String) -> Bool
    typealias UnicodeSender = (DriverRequest, DriverCore, Int32, String) throws -> Void
    private let qualification: Qualification
    private let sendUnicode: UnicodeSender?
    private let pause: (Double) -> Void

    #if SLEIGHT_DRIVER_FIXTURES
    static var fixtureStartup: ((DriverObject) -> DriverSemantic)?
    #endif
    static func startup(fixture: DriverObject?) -> DriverSemantic? {
        #if SLEIGHT_DRIVER_FIXTURES
        // Existing stdin fixtures must never inspect the real clipboard bank.
        if let fixture = fixture { return fixtureStartup?(fixture) }
        #endif
        return DriverSemantic(beforeInput: { _, _ in throw DriverFault("ACTION_UNSUPPORTED") })
    }

    init(access: DriverSemanticAccess = .system,
         qualification: @escaping Qualification = { _, _, _, _ in false },
         beforeInput: @escaping Guard,
         sendUnicode: UnicodeSender? = nil,
         pause: @escaping (Double) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.access = access; self.qualification = qualification
        self.beforeInput = beforeInput; self.sendUnicode = sendUnicode; self.pause = pause
    }
    func shutdown() {} // No clipboard state or recovery callback to drain.
    func register(in runtime: DriverRuntime) {
        for method in Self.methods {
            runtime.registerAction(method: method, handler: { [self] request, core in try handle(request, core: core) })
        }
    }
    private func text(_ value: Any?, empty: Bool = true) throws -> String {
        guard let value = value as? String, (empty || !value.isEmpty), Self.withinTextLimit(value) else { throw DriverFault("INVALID_PARAMS") }
        return value
    }
    private func target(_ value: Any) throws {
        if let object = value as? DriverObject, object.count == 1, driverBoolean(object["focused"]) == true { return }
        if let n = driverInteger(value), n >= 0 { return }
        if let object = value as? DriverObject, object.count == 1,
           let key = object.keys.first, ["id", "label"].contains(key),
           let value = object[key] as? String, !value.isEmpty, value.utf16.count <= 16_384 { return }
        throw DriverFault("INVALID_PARAMS")
    }
    private func args(_ request: DriverRequest) throws -> [Any] {
        try request.keys(["windowId", "processStart", "readId", "args"], optional: ["personToken"])
        guard driverInteger(request.params["readId"]).map({ $0 > 0 }) == true,
              let args = request.params["args"] as? [Any] else { throw DriverFault("INVALID_PARAMS") }
        switch request.method {
        case "setValue":
            guard args.count == 2 else { throw DriverFault("INVALID_PARAMS") }; try target(args[0])
            if args[1] is String { _ = try text(args[1]) }
            else if let number = args[1] as? NSNumber, number.doubleValue.isFinite { }
            else { throw DriverFault("INVALID_PARAMS") }
        case "selectText":
            guard args.count == 2 || args.count == 3 else { throw DriverFault("INVALID_PARAMS") }
            try target(args[0]); _ = try text(args[1], empty: false)
            if args.count == 3 {
                guard let options = args[2] as? DriverObject,
                      Set(options.keys).isSubset(of: ["prefix", "suffix", "selectionType"]) else { throw DriverFault("INVALID_PARAMS") }
                for key in ["prefix", "suffix"] where options[key] != nil { _ = try text(options[key]) }
                if let type = options["selectionType"] { guard ["text", "cursor_before", "cursor_after"].contains(type as? String ?? "") else { throw DriverFault("INVALID_PARAMS") } }
            }
        case "performSecondaryAction":
            guard args.count == 2 else { throw DriverFault("INVALID_PARAMS") }
            try target(args[0]); _ = try text(args[1], empty: false)
        case "paste":
            guard args.count == 1 || args.count == 2 else { throw DriverFault("INVALID_PARAMS") }
            _ = try text(args[0])
            if args.count == 2 {
                guard let options = args[1] as? DriverObject, Set(options.keys).isSubset(of: ["format"]),
                      options["format"] == nil || ["text", "md", "html"].contains(options["format"] as? String ?? "") else { throw DriverFault("INVALID_PARAMS") }
            }
        default: throw DriverFault("METHOD_NOT_FOUND")
        }
        return args
    }
    // Role/subrole and every ancestor are checked before any value access. This
    // also catches a field that became secure since the retained tree was read.
    private func nonsecure(_ element: DriverElement, request: DriverRequest) throws {
        guard !element.secure else { throw DriverFault("SECURE_FIELD") }
        var current = element.node
        for _ in 0..<66 {
            let attrs = try access.attributes(current, [kAXRoleAttribute, kAXSubroleAttribute], request)
            guard let role = attrs[kAXRoleAttribute] as? String else { throw DriverFault("STALE_ELEMENT") }
            if role == "AXSecureTextField" || attrs[kAXSubroleAttribute] as? String == "AXSecureTextField" { throw DriverFault("SECURE_FIELD") }
            if current.same(element.root) { return }
            guard let parent = try access.parent(current, request) else { throw DriverFault("STALE_ELEMENT") }
            current = parent
        }
        throw DriverFault("STALE_ELEMENT")
    }
    private func checked(_ request: DriverRequest, core: DriverCore, target: Any, focused: Bool = false) throws -> (DriverElement, DriverBoundWindow) {
        try request.check()
        try beforeInput(request, core)
        try request.check()
        let state = try core.session.checkBeforeDesktop(allowLocked: request.allowLocked)
        guard !state.secureInput else { throw DriverFault("SECURE_INPUT_ACTIVE") }
        // Check process start before the read map, matching pointer/keyboard binding.
        let bound = try core.boundWindow(request.params, request: request)
        var params = request.params; params["target"] = target
        let element = try core.resolveElement(params, request: request)
        try nonsecure(element, request: request)
        let activation = !request.inputAdmitted && ["click", "doubleClick", "performSecondaryAction"].contains(request.method)
        let attrs = try access.attributes(element.node, [kAXEnabledAttribute] + (activation ? DriverKeyboard.clipboardMenuAttributes : []), request)
        if activation { try DriverKeyboard.refuseClipboardMenu(attrs, layout: element.node.fake == nil ? nil : [:]) }
        guard driverBoolean(attrs[kAXEnabledAttribute]) != false else { throw DriverFault("ELEMENT_DISABLED") }
        if focused {
            guard let focus = try access.focused(bound, request), focus.same(element.node) else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=semantic-focus") }
        }
        try request.check()
        return (element, bound)
    }
    private func result(_ window: DriverObject, verified: Bool) -> DriverObject {
        ["window": window, "delivery": verified ? "sent-verified" : "sent-unverified", "retry": "read-first", "personTookOver": false, "settled": false]
    }
    // Only a successful AX write may use this. Policy, secure-input and deadline
    // failures still propagate. The parent attaches the existing unconfirmed note.
    private func afterDelivery(_ request: DriverRequest, core: DriverCore, target: Any,
                               window: DriverObject, verify: (DriverElement) throws -> DriverObject) throws -> DriverObject {
        do {
            let (element, _) = try checked(request, core: core, target: target)
            return try verify(element)
        }
        catch let fault as DriverFault where ["STALE_ELEMENT", "WINDOW_NOT_FOUND", "NO_WINDOWS_AVAILABLE", "IDENTITY_UNVERIFIED"].contains(fault.code) {
            return result(window, verified: false)
        }
    }
    private func disposition(_ error: Error, request: DriverRequest) -> DriverFault {
        var fault = error as? DriverFault ?? DriverFault("AX_UNAVAILABLE")
        if fault.disposition.isEmpty {
            fault.disposition = ["delivery": request.inputAdmitted ? "unknown" : "not-sent", "retry": request.inputAdmitted ? "read-first" : "safe"]
        }
        if request.method == "paste" { fault.disposition["clipboard"] = "untouched" }
        return fault
    }
    func handle(_ request: DriverRequest, core: DriverCore) throws -> DriverObject {
        do {
            let args = try args(request)
            if request.method == "paste" { return try paste(request, core: core, args: args) }
            let (element, bound) = try checked(request, core: core, target: args[0])
            switch request.method {
            case "setValue":
                guard try access.isSettable(element.node, kAXValueAttribute, request) else { throw DriverFault("VALUE_NOT_SETTABLE") }
                let (fresh, _) = try checked(request, core: core, target: args[0])
                guard try access.isSettable(fresh.node, kAXValueAttribute, request) else { throw DriverFault("VALUE_NOT_SETTABLE") }
                try beforeInput(request, core); try request.check()
                try nonsecure(fresh, request: request)
                try request.admitInput()
                try access.set(fresh.node, kAXValueAttribute, args[1], request)
                return try afterDelivery(request, core: core, target: args[0], window: bound.window) { after in
                    // The character count can reject a known oversized provider
                    // before requesting AXValue. Missing counts are allowed.
                    let length = try access.attributes(after.node, [kAXNumberOfCharactersAttribute], request)[kAXNumberOfCharactersAttribute]
                    func overLimit() -> DriverObject {
                        var out = result(bound.window, verified: false)
                        out["valueVerified"] = false; out["valueReadback"] = "over-limit"
                        out["valueReadbackLimit"] = Self.textLimit; return out
                    }
                    if let count = driverInteger(length), count > Self.textLimit { return overLimit() }
                    try nonsecure(after, request: request)
                    let value = try access.attributes(after.node, [kAXValueAttribute], request)[kAXValueAttribute]
                    if let text = value as? String, !Self.withinTextLimit(text) { return overLimit() }
                    guard Self.equalValue(value, args[1]) else { throw DriverFault("ACTION_UNCONFIRMED") }
                    var out = result(bound.window, verified: true); out["valueVerified"] = true; return out
                }
            case "selectText": return try select(request, core: core, element: element, window: bound.window, args: args)
            case "performSecondaryAction":
                let name = args[1] as! String
                try DriverKeyboard.refuseClipboardLabel(name)
                guard let action = element.secondary[name], action != kAXPressAction,
                      try access.secondaryActions(element.node, request).contains(where: { $0.label == name && $0.action == action }) else { throw DriverFault("ACTION_UNSUPPORTED") }
                let (fresh, _) = try checked(request, core: core, target: args[0])
                guard try access.actionNames(fresh.node, request).contains(action),
                      try access.secondaryActions(fresh.node, request).contains(where: { $0.label == name && $0.action == action }) else { throw DriverFault("ACTION_UNSUPPORTED") }
                try beforeInput(request, core); try request.check()
                try nonsecure(fresh, request: request)
                try request.admitInput(); try access.perform(fresh.node, action, request)
                return try afterDelivery(request, core: core, target: args[0], window: bound.window) { _ in result(bound.window, verified: false) }
            default: throw DriverFault("METHOD_NOT_FOUND")
            }
        } catch { throw disposition(error, request: request) }
    }
    private static func equalValue(_ a: Any?, _ b: Any) -> Bool {
        if let b = b as? String { return (a as? String).map { sameText($0, b) } ?? false }
        guard let a = a as? NSNumber, let b = b as? NSNumber else { return false }
        // AX checkbox providers commonly return numeric 0/1 after a CFBoolean write.
        if CFGetTypeID(a) == CFBooleanGetTypeID() || CFGetTypeID(b) == CFBooleanGetTypeID() {
            return [0.0, 1.0].contains(a.doubleValue) && a.doubleValue == b.doubleValue
        }
        return a == b
    }
    private static func sameText(_ a: String, _ b: String) -> Bool { a.utf16.elementsEqual(b.utf16) }
    private static func withinTextLimit(_ value: String) -> Bool {
        // Stop at the first excess byte, including for non-ASCII providers.
        value.utf8.prefix(textLimit + 1).count <= textLimit
    }
    private func stringValue(_ element: DriverElement, request: DriverRequest) throws -> String {
        try nonsecure(element, request: request)
        let count = try access.attributes(element.node, [kAXNumberOfCharactersAttribute], request)[kAXNumberOfCharactersAttribute]
        guard driverInteger(count).map({ $0 <= Self.textLimit }) != false else { throw DriverStrictText.unsupported() }
        try nonsecure(element, request: request)
        guard let value = try access.attributes(element.node, [kAXValueAttribute], request)[kAXValueAttribute] as? String,
              Self.withinTextLimit(value) else { throw DriverFault("ACTION_UNSUPPORTED") }
        return value
    }
    private func range(_ element: DriverElement, value: String, request: DriverRequest) throws -> [Int] {
        try nonsecure(element, request: request)
        guard let raw = try access.attributes(element.node, [kAXSelectedTextRangeAttribute], request)[kAXSelectedTextRangeAttribute] as? [Any],
              raw.count == 2, let location = driverInteger(raw[0]), let length = driverInteger(raw[1]), location >= 0,
              length >= 0, location <= value.utf16.count, length <= value.utf16.count - location else { throw DriverFault("ACTION_UNSUPPORTED") }
        let units = value as NSString
        func scalarBoundary(_ offset: Int) -> Bool {
            if offset == 0 || offset == units.length { return true }
            return !(0xD800...0xDBFF).contains(units.character(at: offset - 1)) ||
                   !(0xDC00...0xDFFF).contains(units.character(at: offset))
        }
        guard scalarBoundary(location), scalarBoundary(location + length) else { throw DriverStrictText.unsupported() }
        return [location, length]
    }
    private func select(_ request: DriverRequest, core: DriverCore, element: DriverElement, window: DriverObject, args: [Any]) throws -> DriverObject {
        let value = try stringValue(element, request: request), haystack = value as NSString, needle = args[1] as! String
        let options = args.count == 3 ? args[2] as! DriverObject : [:]
        let prefix = options["prefix"] as? String, suffix = options["suffix"] as? String
        let units = Array(value.utf16), prefixUnits = prefix.map { Array($0.utf16) }, suffixUnits = suffix.map { Array($0.utf16) }
        var match: NSRange?, matches = 0, start = 0
        while start <= haystack.length {
            try request.check()
            let found = haystack.range(of: needle, options: .literal, range: NSRange(location: start, length: haystack.length - start))
            if found.location == NSNotFound { break }
            let end = found.location + found.length
            let before = prefixUnits.map { p in found.location >= p.count && units[(found.location - p.count)..<found.location].elementsEqual(p) } ?? true
            let after = suffixUnits.map { s in haystack.length - end >= s.count && units[end..<(end + s.count)].elementsEqual(s) } ?? true
            if before && after { matches += 1; if match == nil { match = found } }
            start = found.location + 1 // Include overlapping literal matches.
        }
        guard let found = match else { throw DriverFault("STALE_ELEMENT") }
        guard matches == 1 else {
            var fault = DriverFault("AMBIGUOUS_ELEMENT")
            fault.disposition = ["delivery": request.inputAdmitted ? "unknown" : "not-sent",
                "retry": request.inputAdmitted ? "read-first" : "safe", "matchCount": matches]
            throw fault
        }
        var selected = [found.location, found.length]
        if options["selectionType"] as? String == "cursor_before" { selected[1] = 0 }
        if options["selectionType"] as? String == "cursor_after" { selected = [selected[0] + selected[1], 0] }
        guard try access.isSettable(element.node, kAXSelectedTextRangeAttribute, request) else { throw DriverFault("VALUE_NOT_SETTABLE") }
        let (fresh, _) = try checked(request, core: core, target: args[0])
        guard try access.isSettable(fresh.node, kAXSelectedTextRangeAttribute, request) else { throw DriverFault("VALUE_NOT_SETTABLE") }
        try beforeInput(request, core); try request.check()
        guard Self.sameText(try stringValue(fresh, request: request), value) else { throw DriverFault("STALE_ELEMENT") }
        try nonsecure(fresh, request: request)
        try request.admitInput(); try access.set(fresh.node, kAXSelectedTextRangeAttribute, selected, request)
        let (after, _) = try checked(request, core: core, target: args[0])
        guard Self.sameText(try stringValue(after, request: request), value),
              try range(after, value: value, request: request) == selected else { throw DriverFault("ACTION_UNCONFIRMED") }
        var out = result(window, verified: true); out["selectedRange"] = selected; out["matchCount"] = matches; return out
    }

    // RT8 must run lease, payment and flow admission before calling this seam.
    // A menu target is bound by its retained title path, not a window-relative
    // pointer frame. Dormant AppKit menu items often have no frame at all.
    // Every path component and sibling match is checked again before AXPress.
    func tryMenuPress(_ request: DriverRequest, core: DriverCore) throws -> DriverObject? {
        guard request.method == "click", let args = request.params["args"] as? [Any], args.count == 1 || args.count == 2 else { return nil }
        if args.count == 2 {
            guard let options = args[1] as? DriverObject, Set(options.keys).isSubset(of: ["mouseButton", "clickCount"]),
                  options["mouseButton"] == nil || options["mouseButton"] as? String == "left",
                  options["clickCount"] == nil || driverInteger(options["clickCount"]) == 1 else { return nil }
        }
        guard let id = request.params["windowId"] as? String, let map = core.maps[id] else { return nil }
        let candidates: [DriverElement]
        if let n = driverInteger(args[0]) { candidates = map.elements[n].map { [$0] } ?? [] }
        else if let selector = args[0] as? DriverObject, selector.count == 1 {
            if let label = selector["label"] as? String { candidates = map.elements.values.filter { $0.label == label } }
            else if let identifier = selector["id"] as? String { candidates = map.elements.values.filter { $0.identifier == identifier } }
            else { return nil }
        } else { return nil }
        guard candidates.contains(where: { ["AXMenuItem", "AXMenuBarItem"].contains($0.role) }) else { return nil }
        do {
            try request.check()
            // Submenu inspection is guarded and shares the action disposition.
            // A menu-bar click must never reach AXPress or pointer fallback.
            if candidates.count == 1, candidates[0].role == "AXMenuBarItem" {
                var fault = DriverFault("ACTION_UNSUPPORTED")
                fault.disposition["menuRefusal"] = "menu-compound"
                throw fault
            }
            if candidates.count == 1, candidates[0].role == "AXMenuItem",
               !(try access.children(candidates[0].node, request)).isEmpty {
                if candidates[0].root.same(map.root) { throw DriverFault("ACTION_UNSUPPORTED") }
                return nil
            }
            func checkedMenu() throws -> (DriverElement, DriverBoundWindow) {
                try request.check(); try beforeInput(request, core)
                guard !(try core.session.checkBeforeDesktop(allowLocked: request.allowLocked)).secureInput else { throw DriverFault("SECURE_INPUT_ACTIVE") }
                let bound = try core.boundWindow(request.params, request: request)
                var params = request.params; params["target"] = args[0]
                let element = try core.resolveElement(params, request: request, requireFrame: false)
                guard !element.secure, element.role == "AXMenuItem" else { throw DriverFault("STALE_ELEMENT") }
                if element.root.same(bound.root) {
                    try checkedPopup(element, bound: bound, map: map, request: request, core: core)
                    return (element, bound)
                }
                guard let menu = bound.menu, element.root.same(menu) else { throw DriverFault("STALE_ELEMENT") }
                var node = element.node
                var selectors: [DriverCompoundSelector] = [], rawNodes: [DriverCompoundRawNode] = []
                var tokens: [DriverNode] = []
                func token(_ node: DriverNode) -> String {
                    if let index = tokens.firstIndex(where: { $0.same(node) }) { return String(index) }
                    tokens.append(node); return String(tokens.count - 1)
                }
                func record(_ child: DriverNode, parent: DriverNode?) throws {
                    let attrs = try access.attributes(child, [kAXRoleAttribute, kAXSubroleAttribute] + driverCoordinateAttributes, request)
                    let role = attrs[kAXRoleAttribute] as? String ?? ""
                    let parentExpanded = try parent.map { parent in
                        let state = try access.attributes(parent, ["AXExpanded", kAXSelectedAttribute, kAXRoleAttribute], request)
                        return driverBoolean(state["AXExpanded"]) == true || state[kAXRoleAttribute] as? String == "AXMenuBarItem" && driverBoolean(state[kAXSelectedAttribute]) == true
                    } ?? false
                    let raw = DriverCompoundRawNode(token: token(child), parent: parent.map { token($0) } ?? "",
                        role: role, title: attrs[kAXTitleAttribute] as? String,
                        description: attrs[kAXDescriptionAttribute] as? String,
                        active: role == "AXMenuBar" || driverBoolean(attrs["AXExpanded"]) == true || role == "AXMenu" && parentExpanded,
                        enabled: driverBoolean(attrs[kAXEnabledAttribute]) != false,
                        secure: role == "AXSecureTextField" || attrs[kAXSubroleAttribute] as? String == "AXSecureTextField")
                    rawNodes.removeAll { $0.token == raw.token }; rawNodes.append(raw)
                }
                for _ in 0..<66 {
                    guard let retained = map.elements.values.first(where: { $0.node.same(node) }) else { throw DriverFault("STALE_ELEMENT") }
                    let attrs = try access.attributes(node, [kAXRoleAttribute, kAXSubroleAttribute] + driverCoordinateAttributes, request)
                    guard attrs[kAXRoleAttribute] as? String == retained.role,
                          driverCoordinateIdentity(attrs) == retained.coordinateIdentity else { throw DriverFault("STALE_ELEMENT") }
                    guard !retained.secure else { throw DriverFault("SECURE_FIELD") }
                    if node.same(element.node) {
                        try DriverKeyboard.refuseClipboardMenu(access.attributes(node, DriverKeyboard.clipboardMenuAttributes, request), layout: node.fake == nil ? nil : [:])
                        guard driverBoolean(attrs[kAXEnabledAttribute]) != false else { throw DriverFault("ELEMENT_DISABLED") }
                        guard try access.actionNames(node, request).contains(kAXPressAction) else { throw DriverFault("ACTION_UNSUPPORTED") }
                        // Only a leaf command qualifies for the unopened path.
                        if element.role == "AXMenuItem", !(try access.children(node, request)).isEmpty { throw DriverFault("ACTION_UNSUPPORTED") }
                    }
                    if node.same(menu) {
                        try record(menu, parent: nil)
                        do {
                            guard let path = try DriverCompoundResolver.unopened(selectors.reversed(), bar: token(menu),
                                ownerProved: true, nodes: rawNodes),
                                  path.last?.token == token(element.node) else { throw DriverFault("STALE_ELEMENT") }
                        } catch DriverCompoundStop.ambiguous { throw DriverFault("AMBIGUOUS_ELEMENT") }
                          catch DriverCompoundStop.disabled { throw DriverFault("ELEMENT_DISABLED") }
                          catch is DriverCompoundStop { throw DriverFault("STALE_ELEMENT") }
                        return (element, bound)
                    }
                    if ["AXMenuItem", "AXMenuBarItem"].contains(retained.role) {
                        let title = attrs[kAXTitleAttribute] as? String ?? ""
                        let description = attrs[kAXDescriptionAttribute] as? String ?? ""
                        guard !title.isEmpty || !description.isEmpty else { throw DriverFault("STALE_ELEMENT") }
                        selectors.append(DriverCompoundSelector(role: retained.role,
                            source: title.isEmpty ? "description" : "title", label: title.isEmpty ? description : title))
                    }
                    guard let parent = try access.parent(node, request) else { throw DriverFault("STALE_ELEMENT") }
                    let children = try access.children(parent, request)
                    for child in children { try record(child, parent: parent) }
                    guard children.filter({ $0.same(node) }).count == 1 else { throw DriverFault("STALE_ELEMENT") }
                    let sameLabel = try children.filter { child in
                        let other = try access.attributes(child, [kAXRoleAttribute, kAXTitleAttribute, kAXDescriptionAttribute], request)
                        return other[kAXRoleAttribute] as? String == retained.role &&
                            driverClean(other[kAXTitleAttribute]) == driverClean(attrs[kAXTitleAttribute]) &&
                            driverClean(other[kAXDescriptionAttribute]) == driverClean(attrs[kAXDescriptionAttribute])
                    }
                    guard sameLabel.count == 1 else { throw DriverFault("AMBIGUOUS_ELEMENT") }
                    node = parent
                }
                throw DriverFault("STALE_ELEMENT")
            }
            let (element, _) = try checkedMenu()
            let (fresh, bound) = try checkedMenu()
            guard fresh.node.same(element.node) else { throw DriverFault("STALE_ELEMENT") }
            try beforeInput(request, core); try request.check()
            request.actionEvent?.prepare(window: bound.window)
            try request.admitInput(); try access.perform(fresh.node, kAXPressAction, request)
            var out = result(bound.window, verified: false)
            out["semantics"] = "menu-accessibility"
            return out
        } catch { throw disposition(error, request: request) }
    }

    private func checkedPopup(_ element: DriverElement, bound: DriverBoundWindow, map: DriverReadMap,
                              request: DriverRequest, core: DriverCore) throws {
        guard !map.truncated, map.root.same(bound.root),
              let id = bound.window["windowId"] as? String,
              let menuNode = try access.parent(element.node, request),
              let menu = map.elements.values.first(where: { $0.node.same(menuNode) }), menu.role == "AXMenu",
              let line = map.text?.split(separator: "\n").first(where: {
                  $0.trimmingCharacters(in: .whitespaces).hasPrefix("\(menu.number) menu (")
              }), !line.isEmpty else { throw DriverFault("STALE_ELEMENT") }
        let prefix = "\(menu.number) menu ("
        let flags = line.trimmingCharacters(in: .whitespaces).dropFirst(prefix.count).prefix { $0 != ")" }
            .split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard flags.contains("expanded") && !flags.contains("collapsed") else { throw DriverFault("STALE_ELEMENT") }
        guard let record = core.popups.record(menu: menuNode, window: id, root: bound.root, sequence: core.person.inputSequence()) else {
            var fault = DriverFault("ACTION_UNSUPPORTED")
            fault.disposition["menuRefusal"] = "person-popup"
            throw fault
        }
        // Prove the actual AX chain, twice through checkedMenu. A matching title
        // or a retained traversal parent alone cannot establish an owner.
        guard let owner = try access.parent(menuNode, request), owner.same(record.owner),
              let retainedOwner = map.elements.values.first(where: { $0.node.same(owner) }),
              retainedOwner.root.same(bound.root) else { throw DriverFault("STALE_ELEMENT") }
        var current = owner, ended = false
        for _ in 0..<66 {
            if current.same(bound.root) { ended = true; break }
            let attrs = try access.attributes(current, [kAXRoleAttribute], request)
            guard !["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"].contains(attrs[kAXRoleAttribute] as? String ?? ""),
                  current.pid().map({ Int($0) == driverInteger(bound.window["pid"]) }) ?? (current.fake != nil),
                  let parent = try access.parent(current, request) else { throw DriverFault("STALE_ELEMENT") }
            current = parent
        }
        guard ended else { throw DriverFault("STALE_ELEMENT") }
        var nodes: [DriverCompoundRawNode] = [], tokens: [DriverNode] = []
        func token(_ node: DriverNode) -> String {
            if let index = tokens.firstIndex(where: { $0.same(node) }) { return String(index) }
            tokens.append(node); return String(tokens.count - 1)
        }
        func check(_ node: DriverNode, parent: DriverNode?) throws {
            guard tokens.count < 10_000,
                  let retained = map.elements.values.first(where: { $0.node.same(node) }), !retained.secure,
                  !retained.menuIdentity.values.contains("unsupported") else { throw DriverFault("STALE_ELEMENT") }
            let attrs = try access.attributes(node, [kAXRoleAttribute, kAXSubroleAttribute] + driverMenuAttributes, request)
            guard attrs[kAXRoleAttribute] as? String == retained.role,
                  driverCoordinateIdentity(attrs, attributes: driverMenuAttributes) == retained.menuIdentity else { throw DriverFault("STALE_ELEMENT") }
            if let parent = parent {
                guard let actual = try access.parent(node, request), actual.same(parent) else { throw DriverFault("STALE_ELEMENT") }
            }
            let children = try access.children(node, request)
            let printedChildren = map.elements.values.filter { $0.parent?.same(node) == true }
            if let expected = retained.collapsedSubmenuItems {
                // Only the printed parent and its count are context. Private
                // submenu rows supply neither numbers nor resolver candidates.
                guard !children.isEmpty, printedChildren.isEmpty else { throw DriverFault("STALE_ELEMENT") }
                var count = 0, menus = 0
                for submenu in children {
                    if try access.attributes(submenu, [kAXRoleAttribute], request)[kAXRoleAttribute] as? String == "AXMenu" {
                        menus += 1; count += try access.children(submenu, request).count
                    }
                }
                guard menus > 0, count == expected else { throw DriverFault("STALE_ELEMENT") }
            } else {
                guard children.count == printedChildren.count,
                      children.allSatisfy({ child in printedChildren.contains { $0.node.same(child) } }) else { throw DriverFault("STALE_ELEMENT") }
            }
            let actions: [String]
            if node.same(element.node) { actions = try access.actionNames(node, request) }
            else { actions = [] }
            nodes.append(DriverCompoundRawNode(token: token(node), parent: parent.map(token) ?? "", role: retained.role,
                title: attrs[kAXTitleAttribute] as? String, description: attrs[kAXDescriptionAttribute] as? String,
                active: true, enabled: driverBoolean(attrs[kAXEnabledAttribute]) != false, secure: false, actions: actions))
            if node.same(element.node) {
                guard children.isEmpty else { throw DriverFault("ACTION_UNSUPPORTED") }
                try DriverKeyboard.refuseClipboardMenu(access.attributes(node, DriverKeyboard.clipboardMenuAttributes, request), layout: node.fake == nil ? nil : [:])
                guard actions.contains(kAXPressAction) else { throw DriverFault("ACTION_UNSUPPORTED") }
            }
            if retained.collapsedSubmenuItems == nil { for child in children { try check(child, parent: node) } }
        }
        try check(owner, parent: nil)
        let attrs = try access.attributes(element.node, [kAXTitleAttribute, kAXDescriptionAttribute], request)
        let title = attrs[kAXTitleAttribute] as? String ?? "", description = attrs[kAXDescriptionAttribute] as? String ?? ""
        guard !title.isEmpty || !description.isEmpty else { throw DriverFault("STALE_ELEMENT") }
        do {
            let resolved = try DriverCompoundResolver.exact(DriverCompoundSelector(role: "AXMenuItem",
                source: title.isEmpty ? "description" : "title", label: title.isEmpty ? description : title),
                container: token(menuNode), complete: true, ownerProved: true, nodes: nodes)
            guard resolved.token == token(element.node) else { throw DriverFault("STALE_ELEMENT") }
        } catch DriverCompoundStop.ambiguous { throw DriverFault("AMBIGUOUS_ELEMENT") }
          catch DriverCompoundStop.disabled { throw DriverFault("ELEMENT_DISABLED") }
          catch is DriverCompoundStop { throw DriverFault("STALE_ELEMENT") }
        guard record.sequence == core.person.inputSequence() else { throw DriverFault("PERSON_TOOK_OVER") }
    }

    // LAWS permits precisely a plain single click on an AXPress-advertising member
    // of a group of sibling buttons/tabs. Nil leaves ordinary pointer dispatch to RT8.
    // Once a press is attempted, a thrown failure MUST NOT fall back to a pointer click.
    func trySiblingPress(_ request: DriverRequest, core: DriverCore) throws -> DriverObject? {
        guard request.method == "click", let args = request.params["args"] as? [Any], args.count == 1 || args.count == 2 else { return nil }
        if args.count == 2 {
            guard let options = args[1] as? DriverObject, Set(options.keys).isSubset(of: ["mouseButton", "clickCount"]),
                  options["mouseButton"] == nil || options["mouseButton"] as? String == "left",
                  options["clickCount"] == nil || driverInteger(options["clickCount"]) == 1 else { return nil }
        }
        do { try target(args[0]) } catch { return nil }
        do {
            try request.keys(["windowId", "processStart", "readId", "args"], optional: ["personToken"])
            var selector = request.params; selector["target"] = args[0]
            let candidate = try core.resolveElement(selector, request: request)
            let metadata = try access.attributes(candidate.node, [kAXRoleAttribute, kAXSubroleAttribute], request)
            guard Self.buttonOrTab(metadata) else { return nil }
            let (element, bound) = try checked(request, core: core, target: args[0])
            func eligible(_ element: DriverElement) throws -> Bool {
                let attrs = try access.attributes(element.node, [kAXRoleAttribute, kAXSubroleAttribute], request)
                guard Self.buttonOrTab(attrs), try access.actionNames(element.node, request).contains(kAXPressAction),
                      let parent = try access.parent(element.node, request) else { return false }
                let role = try access.attributes(parent, [kAXRoleAttribute], request)[kAXRoleAttribute] as? String
                guard ["AXGroup", "AXTabGroup"].contains(role ?? "") else { return false }
                let children = try access.children(parent, request)
                guard children.count <= 256, children.contains(where: { $0.same(element.node) }) else { return false }
                // Admission just produced this map. Use its roles to find a
                // likely witness, then check that one live sibling. AX roles
                // can drift silently, so cached roles alone never authorize a
                // press. Unknown/replaced/drifted witnesses use the old scan.
                if let id = request.params["windowId"] as? String, let map = core.maps[id],
                   map.id == driverInteger(request.params["readId"]) {
                    let retained = Dictionary(map.elements.values.map { (DriverSettleNodeKey(node: $0.node), $0) }, uniquingKeysWith: { first, _ in first })
                    if let witness = children.first(where: { child in
                        guard !child.same(element.node), child.pid().map({ Int($0) == driverInteger(bound.window["pid"]) }) ?? true,
                              let row = retained[DriverSettleNodeKey(node: child)], row.parent?.same(parent) == true else { return false }
                        return Self.buttonOrTab([kAXRoleAttribute: row.role, kAXSubroleAttribute: row.subrole])
                    }), Self.buttonOrTab(try access.attributes(witness, [kAXRoleAttribute, kAXSubroleAttribute], request)) {
                        return true
                    }
                }
                var count = 0
                for child in children {
                    if let pid = child.pid(), driverInteger(bound.window["pid"]) != Int(pid) { continue }
                    let metadata = try access.attributes(child, [kAXRoleAttribute, kAXSubroleAttribute], request)
                    if Self.buttonOrTab(metadata) { count += 1 }
                }
                return count >= 2
            }
            guard try eligible(element) else { return nil }
            try beforeInput(request, core); try request.check()
            try nonsecure(element, request: request)
            // AXPress has no posted pointer step. Publish the admitted read's
            // geometry without adding an AX call or making input depend on it.
            if let action = request.actionEvent {
                action.prepare(window: bound.window, rect: element.frame)
                if let frame = element.frame { action.plan([CGPoint(x: frame.midX, y: frame.midY)]) }
            }
            try request.admitInput(); try access.perform(element.node, kAXPressAction, request)
            var out = try afterDelivery(request, core: core, target: args[0], window: bound.window) { _ in result(bound.window, verified: false) }
            out["semanticPress"] = true; return out
        } catch {
            // Pointer dispatch has its own full admission path. No AX mutation has
            // happened here until admitInput, so pre-press failures may fall through.
            try request.checkClipboardAdmission()
            if !request.inputAdmitted { return nil }
            throw disposition(error, request: request)
        }
    }
    private static func buttonOrTab(_ attrs: DriverObject) -> Bool {
        ["AXButton", "AXTab"].contains(attrs[kAXRoleAttribute] as? String ?? "") || attrs[kAXSubroleAttribute] as? String == "AXTabButton"
    }

    private func paste(_ request: DriverRequest, core: DriverCore, args: [Any]) throws -> DriverObject {
        let format = args.count == 2 ? (args[1] as! DriverObject)["format"] as? String ?? "text" : "text"
        let text = args[0] as! String
        var selectedElement: DriverElement?, boundWindow: DriverBoundWindow?
        var before = "", selected = [Int](), expected = ""
        return try DriverStrictText.dispatch(request, text: text, format: format, resolve: {
            let bound = try core.boundWindow(request.params, request: request)
            guard let focus = try access.focused(bound, request), let id = request.params["windowId"] as? String,
                  let map = core.maps[id], map.id == driverInteger(request.params["readId"]) else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=semantic-read") }
            guard let initial = map.elements.values.first(where: { $0.node.same(focus) }) else { throw DriverFault("STALE_ELEMENT") }
            let (element, _) = try checked(request, core: core, target: initial.number, focused: true)
            guard ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(element.role) else { throw DriverStrictText.unsupported() }
            // Qualification covers selection replacement, Unicode, multiline,
            // undo and app events. A settable bit alone grants no qualification.
            let ax = try qualification(bound, element, .selectedText, text) && access.isSettable(element.node, kAXSelectedTextAttribute, request)
            let unicode = qualification(bound, element, .unicode, text) && text.utf16.count <= 16_384
            guard ax || unicode else { throw DriverStrictText.unsupported() }
            before = try stringValue(element, request: request)
            selected = try range(element, value: before, request: request)
            expected = (before as NSString).replacingCharacters(in: NSRange(location: selected[0], length: selected[1]), with: text)
            guard !Self.sameText(expected, before), Self.withinTextLimit(expected) else { throw DriverStrictText.unsupported() }
            selectedElement = element; boundWindow = bound
            return ax ? .selectedText : .unicode
        }, admit: { path in
            let (fresh, bound) = try checked(request, core: core, target: selectedElement!.number, focused: true)
            guard fresh.node.same(selectedElement!.node), qualification(bound, fresh, path, text) else { throw DriverStrictText.unsupported() }
            guard try path != .selectedText || access.isSettable(fresh.node, kAXSelectedTextAttribute, request) else { throw DriverStrictText.unsupported() }
            try beforeInput(request, core); try request.check()
            guard Self.sameText(try stringValue(fresh, request: request), before),
                  try range(fresh, value: before, request: request) == selected else { throw DriverFault("STALE_ELEMENT") }
            try nonsecure(fresh, request: request)
            selectedElement = fresh; boundWindow = bound
        }, send: { path in
            if path == .selectedText {
                try access.set(selectedElement!.node, kAXSelectedTextAttribute, text, request)
            } else {
                guard let pid = driverInteger(boundWindow!.window["pid"]), pid > 0, pid <= Int(Int32.max) else { throw DriverFault("IDENTITY_UNVERIFIED") }
                if let sendUnicode = sendUnicode { try sendUnicode(request, core, Int32(pid), text) }
                else {
                    try DriverStrictText.postUnicode(request, pid: Int32(pid), text: text, checkpoint: {
                        _ = try checked(request, core: core, target: selectedElement!.number, focused: true)
                    })
                }
            }
        }, observe: { path in
            do {
                let finalRange = [selected[0] + text.utf16.count, 0]
                // Posted events are asynchronous. Observe for at most 250 ms,
                // within the original deadline, with full admission checks on
                // every poll. Mismatch never causes another input send.
                let until = min(request.deadline, ProcessInfo.processInfo.systemUptime + 0.250)
                for attempt in 0...10 {
                    let (after, _) = try checked(request, core: core, target: selectedElement!.number, focused: true)
                    if Self.sameText(try stringValue(after, request: request), expected),
                       try range(after, value: expected, request: request) == finalRange {
                        var out = result(boundWindow!.window, verified: true); out["selectedRange"] = finalRange; return out
                    }
                    let remaining = until - ProcessInfo.processInfo.systemUptime
                    guard path == .unicode, attempt < 10, remaining > 0 else { throw DriverFault("ACTION_UNCONFIRMED") }
                    try request.check(); pause(min(0.025, remaining)); try request.check()
                }
                throw DriverFault("ACTION_UNCONFIRMED")
            } catch let fault as DriverFault where ["STALE_ELEMENT", "WINDOW_NOT_FOUND", "NO_WINDOWS_AVAILABLE", "IDENTITY_UNVERIFIED"].contains(fault.code) {
                return result(boundWindow!.window, verified: false)
            }
        })
    }
}
