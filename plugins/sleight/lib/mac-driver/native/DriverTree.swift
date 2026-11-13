import AppKit
import ApplicationServices
import CryptoKit
import Carbon

func driverClean(_ value: Any?) -> String {
    let text: String
    if let string = value as? String { text = string }
    else if let number = value as? NSNumber { text = number.stringValue }
    else if let url = value as? URL { text = url.absoluteString }
    else { return "" }
    var output = String.UnicodeScalarView(), units = 0
    for scalar in text.unicodeScalars {
        let size = scalar.value > 0xffff ? 2 : 1
        if units + size > 16_384 { break }; units += size
        // Keep the directional marks in recorded numeric values. Other provider
        // controls cannot add rows, and truncation never splits a surrogate pair.
        if scalar.value != 0x200e && scalar.value != 0x200f &&
            (CharacterSet.controlCharacters.contains(scalar) || CharacterSet.illegalCharacters.contains(scalar) || scalar.value == 0x2028 || scalar.value == 0x2029) { output.append(" ") }
        else { output.append(scalar) }
    }
    return String(output)
}

final class DriverNode {
    let ax: AXUIElement?
    let fake: DriverObject?
    let path: String
    init(_ ax: AXUIElement) { self.ax = ax; fake = nil; path = "" }
    init(fake: DriverObject, path: String) { self.fake = fake; self.path = path; ax = nil }
    func timeout(_ request: DriverRequest) throws {
        try request.check()
        let remaining = min(request.remaining, request.walkDeadline.map { max(0, $0 - ProcessInfo.processInfo.systemUptime) } ?? request.remaining)
        guard remaining > 0 else { throw DriverFault("AX_UNAVAILABLE") }
        if let ax = ax { AXUIElementSetMessagingTimeout(ax, Float(min(request.stopCheck == nil ? 0.25 : 0.1, remaining))) }
    }
    func attributes(_ names: [String], request: DriverRequest, strict: Bool = false) throws -> DriverObject {
        try timeout(request)
        if let fake = fake {
            // Only --fixture reaches this provider. Simulate an IPC that ignores
            // its slice so the process watchdog can be tested without an app.
            if let delay = driverInteger(fake["delayMs"]), delay > 0 && delay <= 30_000 { Thread.sleep(forTimeInterval: Double(delay) / 1000) }
            if let forbidden = fake["forbidReads"] as? [String], names.contains(where: forbidden.contains) { throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
            var result = fake.filter { names.contains($0.key) }
            for name in names {
                if let failure = (result[name] as? DriverObject)?["axError"] as? Int {
                    if strict && ![AXError.attributeUnsupported.rawValue, AXError.noValue.rawValue].contains(Int32(failure)) {
                        throw DriverFault("AX_UNAVAILABLE")
                    }
                    result.removeValue(forKey: name)
                }
            }
            return result
        }
        guard let ax = ax else { throw DriverFault("AX_UNAVAILABLE") }
        var values: CFArray?
        let status = AXUIElementCopyMultipleAttributeValues(ax, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
        guard status == .success, let array = values as? [Any], array.count == names.count else {
            if status == .invalidUIElement { throw DriverFault("STALE_ELEMENT") }
            throw DriverFault("AX_UNAVAILABLE")
        }
        var result: DriverObject = [:]
        for (name, value) in zip(names, array) {
            if CFGetTypeID(value as CFTypeRef) != AXValueGetTypeID() { result[name] = value; continue }
            let wrapped = value as! AXValue
            if AXValueGetType(wrapped) != .axError { result[name] = value }
            else if strict {
                var failure = AXError.success
                guard AXValueGetValue(wrapped, .axError, &failure),
                      failure == .attributeUnsupported || failure == .noValue else { throw DriverFault("AX_UNAVAILABLE") }
            }
        }
        return result
    }
    func children(_ request: DriverRequest, limit: Int, cached: Any? = nil) throws -> ([DriverNode], Bool) {
        if let fake = fake {
            let children = fake["children"] as? [DriverObject] ?? []
            return (children.prefix(limit).enumerated().map { DriverNode(fake: $0.element, path: path + "/\($0.offset)") }, children.count > limit)
        }
        let raw = try cached ?? attributes([kAXChildrenAttribute], request: request)[kAXChildrenAttribute]
        let children = raw as? [AXUIElement] ?? []
        return (children.prefix(limit).map(DriverNode.init), children.count > limit)
    }
    func settable(_ attribute: String, request: DriverRequest, strict: Bool = false) throws -> Bool {
        if let fake = fake { return fake[attribute == kAXSelectedAttribute ? "selectable" : "settable"] as? Bool ?? false }
        try timeout(request); var value = DarwinBoolean(false)
        let status = AXUIElementIsAttributeSettable(ax!, attribute as CFString, &value)
        if strict && status != .success && status != .attributeUnsupported { throw DriverFault("AX_UNAVAILABLE") }
        return status == .success && value.boolValue
    }
    func secondaryActions(_ request: DriverRequest, strict: Bool = false) throws -> [(label: String, action: String)] {
        let names: [String]
        if let fake = fake { names = fake["actions"] as? [String] ?? [] }
        else {
            try timeout(request); var values: CFArray?
            let status = AXUIElementCopyActionNames(ax!, &values)
            if strict && status != .success && status != .attributeUnsupported { throw DriverFault("AX_UNAVAILABLE") }
            names = values as? [String] ?? []
        }
        var result = [(label: String, action: String)](), seen = Set<String>(), duplicates = Set<String>()
        for name in names where name != "AXPress" {
            var description: String?
            if let fake = fake { description = (fake["actionDescriptions"] as? [String: String])?[name] }
            else {
                try timeout(request); var value: CFString?
                let status = AXUIElementCopyActionDescription(ax!, name as CFString, &value)
                if strict && status != .success && status != .attributeUnsupported && status != .noValue { throw DriverFault("AX_UNAVAILABLE") }
                if status == .success { description = value as String? }
            }
            let fallback = name.hasPrefix("AX") ? String(name.dropFirst(2)) : name
            let words = fallback.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
                .replacingOccurrences(of: "([A-Z])([A-Z][a-z])", with: "$1 $2", options: .regularExpression)
            let printed = driverClean(description?.isEmpty == false ? description : words)
            guard !printed.isEmpty else { continue }
            if !seen.insert(printed).inserted { duplicates.insert(printed) } else { result.append((printed, name)) }
        }
        return result.filter { !duplicates.contains($0.label) }
    }
    func frame(_ request: DriverRequest, cached: DriverObject? = nil) throws -> CGRect {
        if let frame = fake?["frame"] as? DriverObject {
            guard let x = frame["x"] as? Double, let y = frame["y"] as? Double,
                  let width = frame["width"] as? Double, let height = frame["height"] as? Double,
                  [x, y, width, height].allSatisfy({ $0.isFinite }), width >= 0, height >= 0 else { throw DriverFault("STALE_ELEMENT") }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        let values = try cached ?? attributes([kAXPositionAttribute, kAXSizeAttribute], request: request)
        guard let p = values[kAXPositionAttribute], let s = values[kAXSizeAttribute],
              CFGetTypeID(p as CFTypeRef) == AXValueGetTypeID(), CFGetTypeID(s as CFTypeRef) == AXValueGetTypeID() else { throw DriverFault("STALE_ELEMENT") }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
              [point.x, point.y, size.width, size.height].allSatisfy({ $0.isFinite }), size.width >= 0, size.height >= 0 else { throw DriverFault("STALE_ELEMENT") }
        return CGRect(origin: point, size: size)
    }
    func pid() -> pid_t? {
        if let fake = fake { return driverInteger(fake["pid"]).map(pid_t.init) }
        guard let ax = ax else { return nil }; var pid: pid_t = 0
        return AXUIElementGetPid(ax, &pid) == .success ? pid : nil
    }
    func same(_ other: DriverNode) -> Bool {
        if let ax = ax, let otherAX = other.ax { return CFEqual(ax, otherAX) }
        return fake != nil && other.fake != nil && path == other.path &&
            (fake?["key"] as? String) == (other.fake?["key"] as? String)
    }
    func belongs(to root: DriverNode, pid: Int, request: DriverRequest) throws -> Bool {
        if fake != nil { return self.pid().map { $0 == pid_t(pid) } ?? true }
        var current = self
        for _ in 0..<66 {
            guard current.pid() == pid_t(pid) else { return false }
            if current.same(root) { return true }
            let attrs = try current.attributes([kAXParentAttribute], request: request)
            guard let value = attrs[kAXParentAttribute], CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return false }
            current = DriverNode(value as! AXUIElement)
        }
        return false
    }
}

struct DriverBoundWindow {
    var window: DriverObject
    let root: DriverNode
    let menu: DriverNode?
}

struct DriverElement {
    var number: Int
    let node: DriverNode
    let role: String
    let identifier: String
    let label: String
    let secure: Bool
    let root: DriverNode
    let secondary: [String: String]
    var frame: CGRect? = nil
    var depth = 0
    var coordinateIdentity: [String: String] = [:]
    var focused = false
    var parent: DriverNode? = nil
    var menuIdentity: [String: String] = [:]
    var expanded = false
    var collapsedSubmenuItems: Int? = nil
    var subrole: String = ""
}

let driverCoordinateAttributes = [kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute,
    kAXValueAttribute, kAXEnabledAttribute, kAXSelectedAttribute, kAXFocusedAttribute, "AXExpanded"]
func driverCoordinateIdentity(_ attrs: DriverObject, attributes: [String] = driverCoordinateAttributes) -> [String: String] {
    // Fingerprint the full attributes, including type and absence. Printed
    // truncation or control-character cleaning cannot hide identity drift.
    Dictionary(uniqueKeysWithValues: attributes.map { key in
        let value: String
        if let text = attrs[key] as? String {
            value = text.utf8.count <= 1_048_576 ? "s:" + Data(SHA256.hash(data: Data(text.utf8))).base64EncodedString() : "unsupported"
        }
        else if let number = attrs[key] as? NSNumber {
            value = (CFGetTypeID(number) == CFBooleanGetTypeID() ? "b:" : "n:") + number.stringValue
        } else if attrs[key] == nil { value = "missing" }
        else { value = "unsupported" }
        return (key, value)
    })
}
let driverMenuAttributes = driverCoordinateAttributes + [kAXHelpAttribute, kAXURLAttribute, kAXDocumentAttribute,
    "AXPlaceholderValue", "AXSelectedText", "AXDetails"]

struct DriverReadMap {
    let id: Int
    let processStart: String
    let root: DriverNode
    let elements: [Int: DriverElement]
    var text: String? = nil
    var truncated = true
    var windowIDs: Set<String> = []
    var settleTree: DriverSettleTree? = nil
    var reuse: DriverReadReuse? = nil
    var geometry: DriverGeometryRead? = nil
    var menuCache: DriverMenuCache? = nil

    func coordinateMatches(_ other: DriverReadMap) -> Bool {
        !truncated && !other.truncated && root.same(other.root) && text == other.text &&
        processStart == other.processStart && elements.count == other.elements.count &&
        elements.allSatisfy { number, element in
            guard let next = other.elements[number], let frame = element.frame else { return false }
            return element.node.same(next.node) && element.role == next.role && frame == next.frame &&
                element.depth == next.depth && element.secure == next.secure && element.coordinateIdentity == next.coordinateIdentity
        }
    }
}

let driverRoles = ["AXWindow": "standard window", "AXButton": "button", "AXStaticText": "text",
    "AXTextField": "text field", "AXSecureTextField": "secure text field", "AXTextArea": "text entry area",
    "AXComboBox": "combo box", "AXCheckBox": "checkbox", "AXRadioButton": "radio button",
    "AXGroup": "container", "AXScrollArea": "scroll area", "AXMenu": "menu", "AXMenuBar": "menu bar",
    "AXMenuBarItem": "menu bar item", "AXMenuItem": "menu item", "AXSheet": "sheet", "AXDialog": "dialog",
    "AXPopover": "popover", "AXAlert": "alert", "AXSplitGroup": "split group", "AXToolbar": "toolbar", "AXTabGroup": "tab group",
    "AXTable": "table", "AXRow": "row", "AXColumn": "column", "AXCell": "cell", "AXOutline": "outline",
    "AXImage": "image", "AXLink": "link", "AXWebArea": "web area", "AXSlider": "slider",
    "AXList": "list", "AXLayoutArea": "layout area", "AXLayoutItem": "layout item", "AXHeading": "heading",
    "AXPopUpButton": "pop up button", "AXDisclosureTriangle": "disclosure triangle", "AXValueIndicator": "value indicator",
    "AXMenuButton": "menu button", "AXTab": "tab", "AXProgressIndicator": "progress indicator", "AXSwitch": "switch",
    "AXStepper": "stepper", "AXSearchField": "search field", "AXSplitter": "splitter", "AXScrollBar": "scroll bar",
    "AXHTMLContent": "HTML content", "AXToggleButton": "toggle button", "AXBrowser": "browser", "AXRuler": "ruler",
    "AXRulerMarker": "ruler marker", "AXColorWell": "color well", "AXHandle": "handle", "AXGrid": "grid", "AXSeparator": "separator",
    "AXIncrementArrow": "increment arrow button", "AXDecrementArrow": "decrement arrow button",
    "AXIncrementPage": "increment page button", "AXDecrementPage": "decrement page button"]
let driverSubroles = ["AXCloseButton": "close button", "AXZoomButton": "zoom button", "AXMinimizeButton": "minimize button",
    "AXFullScreenButton": "full screen button", "AXSearchField": "search field", "AXSecureTextField": "secure text field",
    "AXToggleButton": "toggle button", "AXSwitch": "switch", "AXTabButton": "tab", "AXDialog": "dialog",
    "AXSystemDialog": "dialog", "AXFloatingWindow": "floating window", "AXSystemFloatingWindow": "floating window"]
func driverRoleName(_ role: String, _ subrole: String = "") -> String { driverSubroles[subrole] ?? driverRoles[role] ?? "container" }
let driverRoleVocabulary = Set(driverRoles.values).union(driverSubroles.values)
let driverRoleExtensions = Dictionary(uniqueKeysWithValues: driverRoleVocabulary.map { role in
    (role, driverRoleVocabulary.filter { $0.hasPrefix(role + " ") }.map { String($0.dropFirst(role.count + 1)) })
})
func driverRolePrefix(_ role: String, states: [String], label: String) -> String {
    if !states.isEmpty { return role + " (" + states.joined(separator: ", ") + ")" }
    // An empty state group separates a role from a label that could otherwise
    // extend it (menu + "bar x") or masquerade as its state flags.
    let collision = label.hasPrefix("(") || (driverRoleExtensions[role] ?? []).contains { suffix in
        label == suffix || label.hasPrefix(suffix + " ") || label.hasPrefix(suffix + ",")
    }
    return role + (collision ? " ()" : "")
}

// Bounds built in this process hold CGFloat, and bounds parsed from a request hold NSNumber. A boxed CGFloat
// never casts to Double, so every live CG window failed identity with IDENTITY_UNVERIFIED (2026-11-06).
func driverCoordinate(_ value: Any?) -> Double? {
    if let number = value as? NSNumber {
        guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }
    if let float = value as? CGFloat, float.isFinite { return Double(float) }
    return nil
}
func driverRect(_ object: Any?) -> CGRect? {
    guard let b = object as? DriverObject, let x = driverCoordinate(b["x"]), let y = driverCoordinate(b["y"]),
          let w = driverCoordinate(b["width"]), let h = driverCoordinate(b["height"]) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
func driverSameBounds(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 1 && abs(a.minY - b.minY) < 1 && abs(a.width - b.width) < 1 && abs(a.height - b.height) < 1
}

// Only root identity and the focused role are policy facts. Never read a field's value.
func driverWindowPolicy(_ window: DriverObject, root: DriverNode, focused: DriverNode?,
                        secureInput: Bool, request: DriverRequest) throws -> DriverObject {
    var result = window
    let attrs = try root.attributes([kAXSubroleAttribute, kAXIdentifierAttribute], request: request, strict: true)
    result["windowSubrole"] = attrs[kAXSubroleAttribute] as? String
    result["windowIdentifier"] = attrs[kAXIdentifierAttribute] as? String
    result["secureInput"] = secureInput
    result.removeValue(forKey: "focusedSecureField")
    if let focused = focused,
       let focus = try? focused.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request),
       let role = focus[kAXRoleAttribute] as? String, !role.isEmpty {
        result["focusedSecureField"] = role == "AXSecureTextField" || focus[kAXSubroleAttribute] as? String == "AXSecureTextField"
    }
    return result
}

extension DriverCore {
    func windowPolicy(_ window: DriverObject, root: DriverNode, request: DriverRequest) throws -> DriverObject {
        // Recorded windows supply their own facts, including intentionally missing flags.
        if inventory.fixture != nil { return window }
        guard let pid = driverInteger(window["pid"]) else { throw DriverFault("IDENTITY_UNVERIFIED") }
        let app = DriverNode(AXUIElementCreateApplication(pid_t(pid)))
        var focused: DriverNode?
        if let attrs = try? app.attributes([kAXFocusedUIElementAttribute], request: request),
           let value = attrs[kAXFocusedUIElementAttribute], CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() {
            let node = DriverNode(value as! AXUIElement)
            if node.pid() == pid_t(pid) { focused = node }
        }
        return try driverWindowPolicy(window, root: root, focused: focused,
                                      secureInput: IsSecureEventInputEnabled(), request: request)
    }
    func policyWindows(_ payload: DriverObject, request: DriverRequest) throws -> DriverObject {
        var result = payload
        if let windows = payload["windows"] as? [DriverObject] {
            result["windows"] = windows.map { window in
                (try? boundWindow(["windowId": window["windowId"]!, "processStart": window["processStart"]!],
                                  request: request, known: window).window) ?? window
            }
        }
        return result
    }
    // CG visibility alone cannot distinguish another Space from an off-screen
    // window. AX metadata and the app's hidden state refine that observation.
    func windowVisibility(_ window: DriverObject, root: DriverNode, request: DriverRequest,
                          known: DriverObject? = nil) throws -> DriverObject {
        var current = try known ?? inventory.recheck(window)
        guard let before = driverRect(window["bounds"]), let after = driverRect(current["bounds"]),
              driverSameBounds(before, after) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
        let metadata = try root.attributes([kAXMinimizedAttribute, "AXFullScreen"], request: request)
        current["minimized"] = driverBoolean(metadata[kAXMinimizedAttribute]) as Any? ?? NSNull()
        current["fullScreen"] = driverBoolean(metadata["AXFullScreen"]) as Any? ?? NSNull()
        current["fullScreenTile"] = driverBoolean(current["fullScreen"]) == true
            ? inventory.fullScreenTile(current) as Any? ?? NSNull() : false
        // A fixture recheck returns raw CG metadata, just as the real query does.
        for key in ["title", "identityVerified", "identityCorroboration"] { current[key] = window[key] }
        return try windowPolicy(current, root: root, request: request)
    }

    // This binding lives for one keyboard interval. Reuse only the exact AX
    // object bound at its start, with fresh process, CG and AX witnesses at
    // every guard. No running-app census or other windows' AX attributes.
    func keyboardInputWindow(_ bound: DriverBoundWindow, request: DriverRequest) throws -> DriverObject {
        let current = try inventory.recheck(bound.window)
        guard let pid = driverInteger(current["pid"]),
              bound.root.pid() == pid_t(pid) || inventory.fixture != nil && bound.root.pid() == nil else {
            throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid")
        }
        let roots: [DriverNode]
        if let fixture = inventory.fixture, let id = current["windowId"] as? String {
            if let candidates = fixture["axWindows"] as? [DriverObject] {
                roots = candidates.enumerated().map { DriverNode(fake: $0.element, path: id + "/candidate/\($0.offset)") }
            } else if let tree = (fixture["trees"] as? DriverObject)?[id] as? DriverObject {
                roots = [DriverNode(fake: tree, path: id)]
            } else { roots = [] }
        } else {
            let app = DriverNode(AXUIElementCreateApplication(pid_t(pid)))
            let attributes = try app.attributes([kAXWindowsAttribute], request: request, strict: true)
            roots = (attributes[kAXWindowsAttribute] as? [AXUIElement] ?? []).map(DriverNode.init)
        }
        guard roots.filter({ $0.same(bound.root) }).count == 1 else { throw DriverFault("STALE_ELEMENT") }
        let attrs = try bound.root.attributes(["AXWindowNumber"], request: request, strict: true)
        if let number = driverInteger(attrs["AXWindowNumber"]) {
            guard String(number) == current["windowId"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
        } else {
            guard let bounds = driverRect(current["bounds"]), driverSameBounds(try bound.root.frame(request), bounds) else {
                throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds")
            }
        }
        let window = try windowVisibility(bound.window, root: bound.root, request: request, known: current)
        try requireCurrentSpace(window, request: request)
        return window
    }

    func requireCurrentSpace(_ window: DriverObject, request: DriverRequest) throws {
        let location: String
        if driverBoolean(window["hidden"]) == true { location = "the app is hidden; ask the user to unhide it on this Space" }
        else if driverBoolean(window["minimized"]) == true { location = "the window is minimized; ask the user to restore it on this Space" }
        else if driverBoolean(window["onScreen"]) == false {
            location = driverBoolean(window["fullScreen"]) == true
                ? "the window is in a full-screen Space outside the current Space; ask the user to bring it to this Space"
                : "the window is on another Space or off screen; ask the user to bring it to this Space"
        } else if driverBoolean(window["fullScreen"]) == true, driverBoolean(window["fullScreenTile"]) == true {
            location = "Split View or partial full screen; ask the user to exit Split View"
        } else if driverBoolean(window["onScreen"]) == true, driverInteger(window["layer"]) == 0,
                  driverBoolean(window["hidden"]) == false, driverBoolean(window["minimized"]) == false,
                  driverBoolean(window["fullScreen"]) != nil,
                  (driverBoolean(window["fullScreen"]) == false || driverBoolean(window["fullScreenTile"]) == false) { return }
        else { location = "the window's current Space could not be verified; ask the user to bring it to this Space and read again" }
        var fault = DriverFault("NO_WINDOWS_AVAILABLE", "sleight: \(location). Input refused.")
        fault.disposition = ["delivery": request.inputAdmitted ? "unknown" : "not-sent",
                             "retry": request.inputAdmitted ? "read-first" : "safe"]
        throw fault
    }

    func boundWindow(_ params: DriverObject, request: DriverRequest, known: DriverObject? = nil) throws -> DriverBoundWindow {
        let window = try known ?? inventory.bound(params)
        do { return try identifyWindow(window, request: request) }
        catch let fault as DriverFault {
            // AX can omit another Space's window. That never permits input or
            // bypasses identity for reads; give input the available CG advice.
            if request.isAction && ["AX_UNAVAILABLE", "IDENTITY_UNVERIFIED", "STALE_ELEMENT"].contains(fault.code) &&
                (driverBoolean(window["onScreen"]) == false || driverBoolean(window["hidden"]) == true) {
                try requireCurrentSpace(window, request: request)
            }
            if !request.isAction && ["AX_UNAVAILABLE", "IDENTITY_UNVERIFIED", "STALE_ELEMENT"].contains(fault.code) {
                let advice: String?
                if driverBoolean(window["hidden"]) == true {
                    advice = "sleight: the app is hidden; ask the user to unhide it on this Space before input."
                } else if driverBoolean(window["onScreen"]) == false {
                    advice = driverBoolean(window["fullScreen"]) == true
                        ? "sleight: the window is in a full-screen Space outside the current Space; ask the user to bring it to this Space before input."
                        : "sleight: the window is on another Space or off screen; ask the user to bring it to this Space before input."
                } else { advice = nil }
                if let advice = advice {
                    var explained = DriverFault(fault.code, "\(fault.code)\n\(advice)", unhealthy: fault.unhealthy)
                    explained.disposition = fault.disposition; throw explained
                }
            }
            throw fault
        }
    }

    private func identifyWindow(_ metadata: DriverObject, request: DriverRequest) throws -> DriverBoundWindow {
        var window = metadata
        guard let pid = driverInteger(window["pid"]) else { throw DriverFault("IDENTITY_UNVERIFIED", "IDENTITY_UNVERIFIED step=pid") }
        let nodes: [DriverNode], menu: DriverNode?
        if let fixture = inventory.fixture {
            guard let id = window["windowId"] as? String, let trees = fixture["trees"] as? DriverObject,
                  let tree = trees[id] as? DriverObject else { throw DriverFault("AX_UNAVAILABLE") }
            menu = (fixture["menu"] as? DriverObject).map { DriverNode(fake: $0, path: id + "/menu") }
            if let candidates = fixture["axWindows"] as? [DriverObject] {
                nodes = candidates.enumerated().map { DriverNode(fake: $0.element, path: id + "/candidate/\($0.offset)") }
            } else {
                window["identityVerified"] = true; window["identityCorroboration"] = "fixture"
                let root = DriverNode(fake: tree, path: id)
                window = try windowVisibility(window, root: root, request: request)
                if request.isAction { try requireCurrentSpace(window, request: request) }
                return DriverBoundWindow(window: window, root: root, menu: menu)
            }
        } else {
            guard AXIsProcessTrusted() else { throw DriverFault("ACCESSIBILITY_REQUIRED") }
            let app = DriverNode(AXUIElementCreateApplication(pid_t(pid)))
            let attrs = try app.attributes([kAXWindowsAttribute, kAXMenuBarAttribute], request: request)
            nodes = (attrs[kAXWindowsAttribute] as? [AXUIElement] ?? []).map(DriverNode.init)
            if let value = attrs[kAXMenuBarAttribute], CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() { menu = DriverNode(value as! AXUIElement) }
            else { menu = nil }
        }
        var exact = [DriverNode](), fallback = [DriverNode]()
        guard let bounds = driverRect(window["bounds"]) else { throw DriverFault("IDENTITY_UNVERIFIED", "IDENTITY_UNVERIFIED step=bounds") }
        for node in nodes {
            if let owner = node.pid(), owner != pid_t(pid) { continue }
            let metadata = try node.attributes(["AXWindowNumber", kAXTitleAttribute], request: request)
            if let number = driverInteger(metadata["AXWindowNumber"]) {
                if String(number) == window["windowId"] as? String { exact.append(node) }
                continue // A contradictory exposed number never falls back.
            }
            let cgTitle = window["title"] as? String ?? ""
            if let frame = try? node.frame(request), driverSameBounds(frame, bounds),
               cgTitle.isEmpty || driverClean(metadata[kAXTitleAttribute]) == cgTitle { fallback.append(node) }
        }
        let candidates = exact.isEmpty ? fallback : exact
        // AX can omit the off-Space twin, leaving one apparent title/frame
        // match for two CG windows. A named window is ambiguous there too.
        if exact.isEmpty && ((window["title"] as? String ?? "").isEmpty || driverBoolean(window["onScreen"]) != true) &&
            inventory.ambiguousBounds(window) { throw DriverFault("IDENTITY_UNVERIFIED", "IDENTITY_UNVERIFIED step=ambiguous") }
        guard candidates.count == 1, (candidates[0].pid() == nil && inventory.fixture != nil || candidates[0].pid() == pid_t(pid)) else { throw DriverFault("IDENTITY_UNVERIFIED", "IDENTITY_UNVERIFIED step=candidates") }
        let corroboratedTitle = !(window["title"] as? String ?? "").isEmpty
        let metadata = try candidates[0].attributes([kAXTitleAttribute, kAXMinimizedAttribute], request: request)
        window["title"] = driverClean(metadata[kAXTitleAttribute])
        window["minimized"] = driverBoolean(metadata[kAXMinimizedAttribute]) as Any? ?? NSNull()
        window["identityVerified"] = true
        window["identityCorroboration"] = exact.isEmpty ? (corroboratedTitle ? "pid-bounds-ax-title" : "pid-bounds") : "window-number"
        window = try windowVisibility(window, root: candidates[0], request: request)
        if request.isAction { try requireCurrentSpace(window, request: request) }
        return DriverBoundWindow(window: window, root: candidates[0], menu: menu)
    }

    func readTree(_ params: DriverObject, request: DriverRequest, known: DriverBoundWindow? = nil,
                  menuAfter: DriverObject? = nil) throws -> DriverObject {
        try session.checkBeforeDesktop(allowLocked: request.allowLocked)
        let id = params["windowId"] as? String ?? ""
        // A failed or reused first observation cannot leave an opening credit
        // for a menu that appears in some later read.
        defer { popups.cancel(window: id) }
        let retained = maps[id]
        let previousMenuTitles = requestedMenuTitles
        if let titles = params["menuRequests"] {
            guard let names = titles as? [String], names.count <= 128, names.allSatisfy({ $0.utf8.count <= 1024 }) else { throw request.invalidParams("menuRequests") }
            requestedMenuTitles = names
        }
        maps.removeValue(forKey: id)
        let began = ProcessInfo.processInfo.systemUptime
        let depthLimit = driverInteger(params["depth"]) ?? 64, budget = driverInteger(params["budgetMs"]) ?? 3000
        guard depthLimit >= 0 && depthLimit <= 64,
              params["depth"] == nil || driverInteger(params["depth"]) != nil else { throw request.invalidParams("depth") }
        guard budget >= 1 && budget <= 30000,
              params["budgetMs"] == nil || driverInteger(params["budgetMs"]) != nil else { throw request.invalidParams("budgetMs") }
        if let raw = params["reuseIfUnchanged"] {
            guard let read = driverInteger(raw), read >= 0 else { throw request.invalidParams("reuseIfUnchanged") }
        }
        let bound: DriverBoundWindow
        var menuRebound = false
        if let before = menuAfter {
            let current = try inventory.recheck(before)
            guard current["windowId"] as? String == before["windowId"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
            guard current["processStart"] as? String == before["processStart"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=process-start") }
            guard current["bundleId"] as? String == before["bundleId"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bundle-id") }
            guard driverInteger(current["pid"]) == driverInteger(before["pid"]) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
            bound = try boundWindow(params, request: request, known: current)
            guard let retained = retained, retained.root.same(bound.root) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-root") }
            menuRebound = driverRect(current["bounds"]) != driverRect(before["bounds"])
            if menuRebound {
                let number = try bound.root.attributes(["AXWindowNumber"], request: request, strict: true)
                guard driverInteger(number["AXWindowNumber"]).map(String.init) == before["windowId"] as? String,
                      bound.root.pid() == pid_t(driverInteger(before["pid"])!) else { throw DriverFault("IDENTITY_UNVERIFIED") }
            }
        } else { bound = try known ?? boundWindow(params, request: request) }
        let reuseEnabled = params["reuseIfUnchanged"] != nil && params["depth"] == nil && params["budgetMs"] == nil
        if reuseEnabled, previousMenuTitles == requestedMenuTitles, let retained = retained, let proof = retained.reuse,
           driverInteger(params["reuseIfUnchanged"]) == retained.id,
           retained.processStart == bound.window["processStart"] as? String,
           retained.root.same(bound.root), !retained.truncated,
           (proof.result["window"] as? DriverObject)?["app"] as? String == bound.window["app"] as? String,
           driverRect(bound.window["bounds"]) == proof.bounds,
           retained.windowIDs == inventory.observedWindowIDs(bound.window).union([id]) {
            let before = proof.observer.sample()
            let digest = try? DriverSettleTree.read(bound.root, request: request, includeScroll: true, forReuse: true, menu: bound.menu)
            let current = try? boundWindow(params, request: request)
            let role = try? bound.root.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String
            let frame = try? bound.root.frame(request)
            let after = proof.observer.sample()
            if proof.matches(digest, before: before, after: after), let current = current,
               current.root.same(retained.root), driverRect(current.window["bounds"]) == proof.bounds,
               (proof.result["window"] as? DriverObject)?["app"] as? String == current.window["app"] as? String,
               role == proof.rootRole, frame == proof.rootFrame,
               retained.windowIDs == inventory.observedWindowIDs(current.window).union([id]) {
                try request.check()
                try session.checkBeforeDesktop(allowLocked: request.allowLocked)
                maps[id] = retained
                try popups.observe(retained, window: id, sequence: person.inputSequence())
                var result = proof.result
                result["window"] = current.window; result["reused"] = true
                result["elapsedMs"] = (ProcessInfo.processInfo.systemUptime - began) * 1000
                geometry.publish(map: retained, window: current.window, request: request.id, reused: true)
                return result
            }
        }
        // Establish the proof on both sides of the rendered walk. A digest
        // taken only afterwards could certify text rendered before a mutation.
        let observationDeadline = min(request.deadline, ProcessInfo.processInfo.systemUptime + 0.04)
        let observation = !reuseEnabled ? DriverReadObservationResult(observer: nil) :
            observeRead.map { DriverReadObservationResult(observer: $0(bound)) } ??
            DriverReadObservation.start(bound, deadline: observationDeadline)
        let observer = observation.observer
        let revision = observer?.sample()
        let initialDigest = observer == nil ? nil : try? DriverSettleTree.read(bound.root, request: request,
            includeScroll: true, forReuse: true, menu: bound.menu)
        let initialFrame = observer == nil ? nil : try? bound.root.frame(request)
        let fingerprinting = observer != nil && initialDigest?.complete == true && initialDigest?.faulted == false
        var renderedHash = SHA256()
        let title = try bound.root.attributes([kAXTitleAttribute], request: request, strict: fingerprinting)
        let freshTitle = driverClean(title[kAXTitleAttribute] ?? bound.window["title"])
        var window = bound.window; window["title"] = freshTitle
        let quoted = String(data: try JSONSerialization.data(withJSONObject: [freshTitle], options: [.fragmentsAllowed]), encoding: .utf8)!
        var text = "Window: \(quoted.dropFirst().dropLast()), App: \(driverClean(window["app"]))."
        var truncated = false, elements = [Int: DriverElement](), seen = [Int: [DriverNode]]()
        var printed = [DriverSettleNodeKey: DriverElement](), barChildren = Set<DriverSettleNodeKey>()
        var textBytes = text.utf8.count
        var anonymousGroups = [(number: Int, depth: Int)]()
        func finishGroups(beforeDepth depth: Int) {
            while let group = anonymousGroups.last, group.depth >= depth {
                anonymousGroups.removeLast()
                // Descendants have already been projected. An empty tail can
                // be removed without ever assigning its number to another node
                // in a published map. Nested empty groups collapse together.
                if elements.count == group.number + 1, let element = elements.removeValue(forKey: group.number) {
                    printed.removeValue(forKey: DriverSettleNodeKey(node: element.node))
                    if let end = text.lastIndex(of: "\n") { textBytes -= text[end...].utf8.count; text.removeSubrange(end...) }
                }
            }
        }
        var focus: String?, hasSelection = false
        // Reserve a quarter of the available read budget, capped at 650 ms for final checks.
        let available = min(request.remaining, Double(budget) / 1000)
        let margin = min(0.65, max(0.005, available / 4))
        let stop = min(request.deadline - margin, began + Double(budget) / 1000)
        request.walkDeadline = stop
        defer { request.walkDeadline = nil }
        var documents = [(DriverNode, Int)](), documentSections = DriverDocumentSections()
        var needsPixels = false, protectedDocument = false
        var stack: [(DriverNode, Int, Bool, DriverNode, Bool, DriverNode?)] = [(bound.root, 0, false, bound.root, false, nil)]
        var menuPending = bound.menu
        var menuSnapshot: DriverMenuSnapshot?, menuCache: DriverMenuCache?
        var menuInputs = [DriverSettleNodeKey: DriverMenuNodeRead]()
        var menuSuffixes = [String](), menuElements = [DriverElement]()
        while !stack.isEmpty || menuPending != nil {
            if ProcessInfo.processInfo.systemUptime >= stop || elements.count >= 10_000 { truncated = true; break }
            if stack.isEmpty, let menu = menuPending {
                // A cached menu appends without popping a depth-zero node.
                // Close the window's tail groups before assigning menu numbers.
                finishGroups(beforeDepth: 0)
                if fingerprinting { driverReuseHash("menu-root", into: &renderedHash) }
                // Validation is per read/action. Missing coverage, AX faults,
                // custom depths and limits all keep the original live walker.
                menuSnapshot = depthLimit == 64 ? try? DriverMenuSnapshot.capture(menu, window: window,
                    requests: requestedMenuTitles, request: request) : nil
                if let snapshot = menuSnapshot {
                    menuInputs = Dictionary(snapshot.nodes.map { (DriverSettleNodeKey(node: $0.node), $0) }, uniquingKeysWith: { first, _ in first })
                    if !truncated, !elements.isEmpty, menuInputs.count == snapshot.nodes.count, let cached = retained?.menuCache, snapshot.matches(cached.snapshot),
                       snapshot.nodes.allSatisfy({ row in
                           let hash = row.node.ax.map { Int(CFHash($0)) } ?? row.node.path.hashValue
                           return !(seen[hash] ?? []).contains(where: { $0.same(row.node) })
                       }),
                       elements.count + cached.elements.count < 10_000,
                       textBytes + cached.suffixes.reduce(0, { $0 + $1.utf8.count + 80 }) < 1_048_576 -
                           max(20_000, max((focus?.utf8.count ?? 0) + 128,
                               cached.elements.indices.filter { cached.elements[$0].focused }.map { cached.suffixes[$0].utf8.count + 128 }.max() ?? 0)) {
                        for (index, old) in cached.elements.enumerated() {
                            try request.check()
                            if ProcessInfo.processInfo.systemUptime >= stop { truncated = true; break }
                            var element = old; element.number = elements.count
                            let line = String(repeating: "\t", count: element.depth) + "\(element.number)" + cached.suffixes[index]
                            text += "\n" + line; textBytes += 1 + line.utf8.count
                            elements[element.number] = element
                            if element.focused { focus = "\(element.number)" + cached.suffixes[index] }
                            if !driverClean(snapshot.nodes[index].attrs["AXSelectedText"]).isEmpty { hasSelection = true }
                            if fingerprinting { snapshot.nodes[index].feed(&renderedHash) }
                        }
                        menuCache = DriverMenuCache(snapshot: snapshot, suffixes: cached.suffixes,
                            elements: cached.elements, wasHit: true)
                        menuPending = nil; continue
                    }
                }
                stack.append((menu, 0, false, menu, false, nil)); menuPending = nil
            }
            let (node, depth, inheritedSecure, root, inheritedDocument, parent) = stack.removeLast()
            finishGroups(beforeDepth: depth)
            let hash = node.ax.map { Int(CFHash($0)) } ?? node.path.hashValue
            if (seen[hash] ?? []).contains(where: { $0.same(node) }) { truncated = true; continue }
            seen[hash, default: []].append(node)
            if let nodePID = node.pid(), nodePID != pid_t(driverInteger(window["pid"])!) { truncated = true; continue }
            let roleAttrs: DriverObject
            let menuInput = menuInputs[DriverSettleNodeKey(node: node)]
            do { roleAttrs = try menuInput?.roleAttrs ?? node.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request, strict: fingerprinting) }
            catch { truncated = true; continue }
            guard let role = roleAttrs[kAXRoleAttribute] as? String else { truncated = true; continue }
            do {
                let secure = inheritedSecure || role == "AXSecureTextField" || roleAttrs[kAXSubroleAttribute] as? String == "AXSecureTextField"
                let documentRoot = driverDocumentRoot(role, roleAttrs[kAXSubroleAttribute] as? String ?? "")
                let documentContent = inheritedDocument || documentRoot
                if secure { protectedDocument = true }
                let attrs: DriverObject
                do {
                    attrs = secure ? [:] : try menuInput?.attrs ?? node.attributes([kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                        kAXIdentifierAttribute, kAXHelpAttribute, kAXURLAttribute, kAXDocumentAttribute,
                        kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, "AXExpanded", "AXPlaceholderValue",
                        "AXSelectedText", "AXDetails", kAXChildrenAttribute, kAXPositionAttribute, kAXSizeAttribute] + (fingerprinting ? ["AXElementBusy"] : []), request: request, strict: fingerprinting)
                } catch { truncated = true; continue }
                let number = elements.count, subrole = roleAttrs[kAXSubroleAttribute] as? String ?? ""
                // Privacy is structural. Hidden rows never receive a number or
                // enter the retained selector map, including in emit:false reads.
                let children = try menuInput?.children ?? node.children(request, limit: max(0, 10_000 - elements.count - stack.count), cached: attrs[kAXChildrenAttribute])
                let parentElement = parent.flatMap { printed[DriverSettleNodeKey(node: $0)] }
                let submenu = try menuInput?.submenu ?? (role == "AXMenuItem" ? children.0.filter {
                    try $0.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String == "AXMenu"
                } : [])
                let requestedSubmenu = requestedMenuTitles.contains { request in
                    let title = [driverClean(attrs[kAXTitleAttribute]), driverClean(attrs[kAXDescriptionAttribute])].first(where: { !$0.isEmpty }) ?? ""
                    return !title.isEmpty && request.compare(title, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
                }
                let submenuExpanded = try menuInput?.submenuExpanded ?? (driverBoolean(attrs["AXExpanded"]) == true || submenu.contains {
                    driverBoolean(try $0.attributes(["AXExpanded"], request: request)["AXExpanded"]) == true
                })
                let hideSubmenu = !submenu.isEmpty && !(requestedSubmenu && submenuExpanded)
                let submenuCount = try menuInput?.submenuCount ?? submenu.reduce(0) { count, menu in count + (try menu.children(request, limit: 10_000).0.count) }
                let barChild = role == "AXMenuBarItem" && parentElement?.role == "AXMenuBar" &&
                    bound.menu.map { root.same($0) && parent?.same($0) == true } == true
                let firstBarChild = barChild && parent.map { barChildren.insert(DriverSettleNodeKey(node: $0)).inserted } == true
                let apple = firstBarChild && ["", "Apple", ""].contains(driverClean(attrs[kAXTitleAttribute]))
                let appleExpanded = try menuInput?.appleExpanded ?? (apple && (driverBoolean(attrs["AXExpanded"]) == true || driverBoolean(attrs[kAXSelectedAttribute]) == true || children.0.contains {
                    driverBoolean(try $0.attributes(["AXExpanded"], request: request)["AXExpanded"]) == true
                }))
                let hideApple = apple && !appleExpanded
                if !secure && documentRoot && !inheritedDocument { documents.append((node, number)) }
                let roleName = number == 0 ? "standard window" : driverRoleName(role, subrole)
                var states = [String]()
                if driverBoolean(attrs[kAXEnabledAttribute]) == false { states.append("disabled") }
                if driverBoolean(attrs[kAXFocusedAttribute]) == true { states.append("focused") }
                if driverBoolean(attrs[kAXSelectedAttribute]) == true { states.append("selected") }
                else if !secure, attrs[kAXSelectedAttribute] != nil, try menuInput?.selectedSettable ?? node.settable(kAXSelectedAttribute, request: request, strict: fingerprinting) { states.append("selectable") }
                let booleanRole = ["AXCheckBox", "AXSwitch", "AXRadioButton"].contains(role) || ["AXSwitch"].contains(subrole)
                if booleanRole && (driverBoolean(attrs[kAXValueAttribute]) == true || driverInteger(attrs[kAXValueAttribute]) == 1) { states.append("checked") }
                // AppKit exposes an open popup's AXMenu under its window, even
                // when its AXExpanded bit incorrectly says false.
                if role == "AXMenu", root.same(bound.root) && !children.0.isEmpty || parentElement?.coordinateIdentity["AXExpanded"] == "b:1" ||
                    parentElement?.role == "AXMenuBarItem" && parentElement?.coordinateIdentity[kAXSelectedAttribute] == "b:1" { states.append("expanded") }
                else if apple && appleExpanded { states.append("expanded") }
                else if let expanded = driverBoolean(attrs["AXExpanded"]) { states.append(expanded ? "expanded" : "collapsed") }
                if !secure && !["AXMenuItem", "AXMenuBarItem"].contains(role) &&
                    ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXCheckBox", "AXSwitch", "AXRadioButton", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXStepper", "AXSearchField"].contains(role),
                    try node.settable(kAXValueAttribute, request: request, strict: fingerprinting) { states.append("settable") }
                if !secure && ["AXSlider", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXStepper", "AXProgressIndicator"].contains(role), attrs[kAXValueAttribute] is NSNumber { states.append("float") }
                if booleanRole && driverBoolean(attrs[kAXValueAttribute]) != nil { states.append("boolean") }
                let label = secure ? "<redacted>" : number == 0 ? freshTitle : driverClean(attrs[kAXTitleAttribute])
                let description = driverClean(attrs[kAXDescriptionAttribute]), value = driverClean(attrs[kAXValueAttribute])
                let inlineStaticValue = role == "AXStaticText" && description.isEmpty && driverClean(attrs[kAXIdentifierAttribute]).isEmpty
                // Routine menu-bar states stay implicit. Other states, including
                // selection, and titles that resemble roles remain explicit.
                let bareMenuItem = role == "AXMenuBarItem" && !label.isEmpty && states.allSatisfy({ $0 == "selectable" || $0 == "collapsed" }) &&
                    !driverRoleVocabulary.contains { label == $0 || label.hasPrefix($0 + " ") || label.hasPrefix($0 + ",") }
                var line = String(repeating: "\t", count: depth) + "\(number)" +
                    (bareMenuItem ? "" : " " + driverRolePrefix(roleName, states: states, label: label))
                if !label.isEmpty { line += " " + label }
                else if inlineStaticValue && !value.isEmpty { line += " " + value }
                let submenuSuffix = hideSubmenu ? " (submenu, \(submenuCount) items)" : ""
                if !label.isEmpty || description.isEmpty { line += submenuSuffix }
                var hasContent = !label.isEmpty || (inlineStaticValue && !value.isEmpty)
                func field(_ prefix: String, _ value: String) {
                    if !value.isEmpty { line += (hasContent ? ", " : " ") + prefix + ": " + value; hasContent = true }
                }
                field("Description", description + (label.isEmpty && !description.isEmpty ? submenuSuffix : ""))
                field("Help", driverClean(attrs[kAXHelpAttribute]))
                if !inlineStaticValue && !(states.contains("float") && label == value) { field("Value", value) }
                field("Details", driverClean(attrs["AXDetails"]))
                field("Placeholder", driverClean(attrs["AXPlaceholderValue"]))
                field("ID", driverClean(attrs[kAXIdentifierAttribute]))
                field("URL", driverClean(attrs[kAXURLAttribute] ?? attrs[kAXDocumentAttribute]))
                let selection = driverClean(attrs["AXSelectedText"])
                if !selection.isEmpty { field("Selected text", "`" + selection.replacingOccurrences(of: "`", with: "\\`") + "`") }
                let actions: [(label: String, action: String)] = secure || ["AXMenuItem", "AXMenuBarItem"].contains(role) ? [] : try menuInput?.actions ?? node.secondaryActions(request, strict: fingerprinting)
                let secondary = Dictionary(uniqueKeysWithValues: actions.map { ($0.label, $0.action) })
                field("Secondary Actions", actions.map { $0.label }.joined(separator: ", "))
                let lineBytes = line.utf8.count
                let proposedFocus = driverBoolean(attrs[kAXFocusedAttribute]) == true ? "\(number) " + String(line.dropFirst(depth + String(number).count + 1)) : focus
                let footerReserve = max(20_000, (proposedFocus?.utf8.count ?? 0) + 128)
                if textBytes + 1 + lineBytes > 1_048_576 - footerReserve { truncated = true; break }
                text += "\n" + line; textBytes += 1 + lineBytes
                focus = proposedFocus
                if !selection.isEmpty { hasSelection = true }
                elements[number] = DriverElement(number: number, node: node, role: role,
                    identifier: secure ? "" : driverClean(attrs[kAXIdentifierAttribute]),
                    label: secure ? "" : [label, description, role == "AXStaticText" ? value : ""].first(where: { !$0.isEmpty }) ?? "", secure: secure, root: root, secondary: secondary,
                    frame: menuInput != nil ? menuInput!.frame : try? node.frame(request, cached: secure ? nil : attrs), depth: depth,
                    coordinateIdentity: secure ? [:] : driverCoordinateIdentity(attrs), focused: driverBoolean(attrs[kAXFocusedAttribute]) == true,
                    parent: parent, menuIdentity: secure ? [:] : driverCoordinateIdentity(attrs, attributes: driverMenuAttributes),
                    expanded: states.contains("expanded"), collapsedSubmenuItems: hideSubmenu ? submenuCount : nil, subrole: subrole)
                printed[DriverSettleNodeKey(node: node)] = elements[number]
                if role == "AXGroup", subrole.isEmpty, !secure, states.isEmpty, !hasContent, actions.isEmpty {
                    anonymousGroups.append((number, depth))
                }
                if menuInput != nil {
                    menuSuffixes.append(String(line.dropFirst(depth + String(number).count)))
                    menuElements.append(elements[number]!)
                }
                do {
                    let (children, cutChildren) = children
                    if fingerprinting {
                        var printed = attrs
                        if number == 0 { printed[kAXTitleAttribute] = freshTitle }
                        driverReuseNodeHash(role: role, subrole: subrole, attributes: printed, valueSettable: states.contains("settable"),
                            selectedSettable: states.contains("selectable"), actions: actions,
                            frame: menuInput?.frame ?? (try? node.frame(request)), children: children.count, into: &renderedHash)
                    }
                    truncated = truncated || cutChildren
                    if hideApple || hideSubmenu { /* Intentionally omitted, not truncated. */ }
                    else if depth >= depthLimit { if !children.isEmpty { truncated = true } }
                    else { for child in children.reversed() { stack.append((child, depth + 1, secure, root, documentContent, node)) } }
                    if !secure && !documentContent && role == "AXCanvas",
                       let frame = try? node.frame(request), frame.width > 0 && frame.height > 0 {
                        needsPixels = true
                    }
                } catch { truncated = true }
            } catch { truncated = true; break }
        }
        finishGroups(beforeDepth: 0)
        var documentTargets = [DriverSettleNodeKey: Int]()
        if !documents.isEmpty {
            for (number, element) in elements { documentTargets[DriverSettleNodeKey(node: element.node)] = number }
        }
        for (node, number) in documents {
            do {
                let read = try DriverDocumentRead.read(node, pid: driverInteger(window["pid"])!, request: request, targets: documentTargets)
                protectedDocument = protectedDocument || read.protected
                needsPixels = needsPixels || read.needsPixels
                documentSections.append(number, read)
            } catch let fault as DriverFault where !fault.unhealthy && ["AX_UNAVAILABLE", "STALE_ELEMENT"].contains(fault.code) {
                // An incomplete safety probe cannot justify an automatic image.
                protectedDocument = true
                documentSections.append(number, DriverDocumentRead(text: "text: structure unavailable", readable: false, protected: true, omitted: 0))
            }
        }
        let digest = try? DriverSettleTree.read(bound.root, request: request, includeScroll: false)
        let settleTree = digest?.faulted == false ? digest : nil
        request.walkDeadline = nil
        try request.check()
        guard !elements.isEmpty else { throw DriverFault("AX_UNAVAILABLE") }
        let final = try inventory.recheck(window)
        guard final["pid"] as? Int == window["pid"] as? Int else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=pid") }
        guard let finalBounds = driverRect(final["bounds"]), let initialBounds = driverRect(window["bounds"]),
              menuAfter != nil || driverSameBounds(initialBounds, finalBounds) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
        if inventory.fixture == nil || menuRebound || menuAfter != nil && !driverSameBounds(initialBounds, finalBounds) {
            guard bound.root.pid() == pid_t(driverInteger(window["pid"])!),
                  driverSameBounds(try bound.root.frame(request), finalBounds) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
            let current = try bound.root.attributes([kAXRoleAttribute, "AXWindowNumber"], request: request)
            guard current[kAXRoleAttribute] as? String == "AXWindow" else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-role") }
            if menuAfter != nil && !driverSameBounds(initialBounds, finalBounds),
               driverInteger(current["AXWindowNumber"]).map(String.init) != window["windowId"] as? String { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
            if let number = driverInteger(current["AXWindowNumber"]), String(number) != window["windowId"] as? String { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
        }
        if menuAfter != nil { window["bounds"] = final["bounds"] }
        for key in ["onScreen", "layer", "hidden"] { window[key] = final[key] }
        let visibility = try bound.root.attributes([kAXMinimizedAttribute, "AXFullScreen"], request: request)
        window["minimized"] = driverBoolean(visibility[kAXMinimizedAttribute]) as Any? ?? NSNull()
        window["fullScreen"] = driverBoolean(visibility["AXFullScreen"]) as Any? ?? NSNull()
        window = try windowPolicy(window, root: bound.root, request: request)
        let footer = focus.map { "The focused UI element is " + $0 } ?? driverNoFocusNote
        if hasSelection { text += "\n" + driverSelectionNote }
        text += "\n" + footer
        nextRead += 1
        maps[id] = DriverReadMap(id: nextRead, processStart: window["processStart"] as! String, root: bound.root, elements: elements,
            text: text, truncated: truncated, windowIDs: inventory.observedWindowIDs(window).union([id]), settleTree: settleTree)
        if !truncated {
            if let cache = menuCache { maps[id]?.menuCache = cache }
            else if let snapshot = menuSnapshot, menuElements.count == snapshot.nodes.count {
                maps[id]?.menuCache = DriverMenuCache(snapshot: snapshot, suffixes: menuSuffixes, elements: menuElements)
            }
        }
        if let map = maps[id] { try popups.observe(map, window: id, sequence: person.inputSequence()) }
        if maps.count > 16, let oldest = maps.min(by: { $0.value.id < $1.value.id })?.key {
            geometry.evict(oldest); maps.removeValue(forKey: oldest)
        }
        var result: DriverObject = ["window": window, "text": text, "readId": nextRead, "truncated": truncated, "reused": false,
                "elapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000]
        if observation.timedOut { result["diagnostics"] = ["readReuse": "observer-timeout"] }
        // Even an empty payload replaces the preceding observation's content
        // channel when parent facts merge another read of the same window.
        result["document"] = ["version": 1, "sections": documentSections.finish(),
            "needsPixels": needsPixels && !protectedDocument, "protected": protectedDocument]
        let renderedDigest = fingerprinting ? renderedHash.finalize().map { String(format: "%02x", $0) }.joined() : nil
        var finalRevision: Int?, finalHash: String?
        if !truncated, let observer = observer, let revision = revision,
           let initial = initialDigest, initial.complete, !initial.faulted, let hash = initial.digest,
           renderedDigest == hash,
           let initialFrame = initialFrame, let bounds = driverRect(window["bounds"]),
           let finalDigest = try? DriverSettleTree.read(bound.root, request: request, includeScroll: true, forReuse: true, menu: bound.menu),
           finalDigest.complete, !finalDigest.faulted, finalDigest.digest == hash,
           let role = try? bound.root.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String,
           let frame = try? bound.root.frame(request), frame == initialFrame,
           { finalRevision = observer.sample(); return finalRevision == revision }() {
            finalHash = finalDigest.digest
            maps[id]?.reuse = DriverReadReuse(observer: observer, revision: revision, digest: hash,
                bounds: bounds, rootFrame: frame, rootRole: role, result: result)
        }
        maps[id]?.geometry = DriverGeometryRead(start: began, end: ProcessInfo.processInfo.systemUptime,
            before: revision, after: finalRevision, initial: initialDigest?.digest, rendered: renderedDigest,
            final: finalHash, notifications: observer?.geometryCoverage ?? false,
            settled: finalHash != nil && initialDigest?.busyElements == 0)
        if let map = maps[id] { geometry.publish(map: map, window: window, request: request.id, reused: false) }
        return result
    }

    func resolveSecondaryAction(_ params: DriverObject, name: String, request: DriverRequest) throws -> (DriverElement, String) {
        let element = try resolveElement(params, request: request)
        guard !element.secure else { throw DriverFault("SECURE_FIELD") }
        guard let action = element.secondary[name], try element.node.secondaryActions(request).contains(where: { $0.label == name && $0.action == action }) else { throw DriverFault("ACTION_UNSUPPORTED") }
        return (element, action)
    }

    func resolveElement(_ params: DriverObject, request: DriverRequest, requireFrame: Bool = true) throws -> DriverElement {
        guard let id = params["windowId"] as? String, let read = driverInteger(params["readId"]),
              let map = maps[id], map.id == read, map.processStart == params["processStart"] as? String else { throw DriverFault("STALE_READ") }
        let bound = try boundWindow(params, request: request)
        guard bound.root.same(map.root) else { maps.removeValue(forKey: id); throw DriverFault("STALE_ELEMENT") }
        let candidates: [DriverElement]
        if let number = driverInteger(params["target"]), number >= 0 { candidates = map.elements[number].map { [$0] } ?? [] }
        else if let selector = params["target"] as? DriverObject, selector.count == 1 {
            if let identifier = selector["id"] as? String, !identifier.isEmpty { candidates = map.elements.values.filter { $0.identifier == identifier } }
            else if let label = selector["label"] as? String, !label.isEmpty { candidates = map.elements.values.filter { $0.label == label } }
            else if driverBoolean(selector["focused"]) == true { candidates = map.elements.values.filter { $0.focused } }
            else { throw DriverFault("INVALID_PARAMS") }
        } else { throw DriverFault("INVALID_PARAMS") }
        guard candidates.count <= 1 else { throw DriverFault("AMBIGUOUS_ELEMENT") }
        guard let element = candidates.first else { throw DriverFault("STALE_ELEMENT") }
        if let selector = params["target"] as? DriverObject, driverBoolean(selector["focused"]) == true {
            guard driverBoolean(try element.node.attributes([kAXFocusedAttribute], request: request)[kAXFocusedAttribute]) == true else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=element-focused") }
        }
        let freshRole = try element.node.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String
        guard freshRole == element.role, try element.node.belongs(to: element.root, pid: driverInteger(bound.window["pid"])!, request: request) else { throw DriverFault("STALE_ELEMENT") }
        let actionFrame = requireFrame ? try element.node.frame(request) : nil
        // Pointer.context records its later frame, the one used for the actual point.
        if request.isAction && !DriverPointer.methods.contains(request.method), let actionFrame = actionFrame {
            request.actionEvent?.prepare(window: bound.window, rect: actionFrame)
        }
        if request.isAction && requireFrame { geometry.retain(element, window: bound.window, action: request.id, drag: request.method == "drag") }
        return element
    }
}
