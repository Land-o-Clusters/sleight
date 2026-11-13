// Frozen tree serializer from rti1 9b5dce331. Test oracle only.
// Changes here require an explicit tree-parity decision.
import AppKit
import ApplicationServices

extension DriverCore {
    func readRti1Tree(_ params: DriverObject, request: DriverRequest, known: DriverBoundWindow? = nil) throws -> DriverObject {
        try session.checkBeforeDesktop(allowLocked: request.allowLocked)
        let id = params["windowId"] as? String ?? ""
        maps.removeValue(forKey: id)
        let began = ProcessInfo.processInfo.systemUptime
        let depthLimit = driverInteger(params["depth"]) ?? 64, budget = driverInteger(params["budgetMs"]) ?? 3000
        guard depthLimit >= 0 && depthLimit <= 64, budget >= 1 && budget <= 30000,
              params["depth"] == nil || driverInteger(params["depth"]) != nil,
              params["budgetMs"] == nil || driverInteger(params["budgetMs"]) != nil else { throw DriverFault("INVALID_PARAMS") }
        let bound = try known ?? boundWindow(params, request: request)
        let title = try bound.root.attributes([kAXTitleAttribute], request: request)
        let freshTitle = driverClean(title[kAXTitleAttribute] ?? bound.window["title"])
        var window = bound.window; window["title"] = freshTitle
        let quoted = String(data: try JSONSerialization.data(withJSONObject: [freshTitle], options: [.fragmentsAllowed]), encoding: .utf8)!
        var text = "Window: \(quoted.dropFirst().dropLast()), App: \(driverClean(window["app"]))."
        var truncated = false, elements = [Int: DriverElement](), seen = [Int: [DriverNode]]()
        var textBytes = text.utf8.count
        var focus: String?, hasSelection = false
        // Reserve a quarter of the available read budget, capped at 650 ms for final checks.
        let available = min(request.remaining, Double(budget) / 1000)
        let margin = min(0.65, max(0.005, available / 4))
        let stop = min(request.deadline - margin, began + Double(budget) / 1000)
        request.walkDeadline = stop
        defer { request.walkDeadline = nil }
        var stack: [(DriverNode, Int, Bool, DriverNode)] = [(bound.root, 0, false, bound.root)]
        var menuPending = bound.menu
        while !stack.isEmpty || menuPending != nil {
            if ProcessInfo.processInfo.systemUptime >= stop || elements.count >= 10_000 { truncated = true; break }
            if stack.isEmpty, let menu = menuPending { stack.append((menu, 0, false, menu)); menuPending = nil }
            let (node, depth, inheritedSecure, root) = stack.removeLast()
            let hash = node.ax.map { Int(CFHash($0)) } ?? node.path.hashValue
            if (seen[hash] ?? []).contains(where: { $0.same(node) }) { truncated = true; continue }
            seen[hash, default: []].append(node)
            if let nodePID = node.pid(), nodePID != pid_t(driverInteger(window["pid"])!) { truncated = true; continue }
            let roleAttrs: DriverObject
            do { roleAttrs = try node.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request) }
            catch { truncated = true; continue }
            guard let role = roleAttrs[kAXRoleAttribute] as? String else { truncated = true; continue }
            do {
                let secure = inheritedSecure || role == "AXSecureTextField" || roleAttrs[kAXSubroleAttribute] as? String == "AXSecureTextField"
                let attrs: DriverObject
                do {
                    attrs = secure ? [:] : try node.attributes([kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
                        kAXIdentifierAttribute, kAXHelpAttribute, kAXURLAttribute, kAXDocumentAttribute,
                        kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, "AXExpanded", "AXPlaceholderValue",
                        "AXSelectedText", "AXDetails", kAXChildrenAttribute], request: request)
                } catch { truncated = true; continue }
                let number = elements.count, subrole = roleAttrs[kAXSubroleAttribute] as? String ?? ""
                let roleName = number == 0 ? "standard window" : driverRoleName(role, subrole)
                var states = [String]()
                if driverBoolean(attrs[kAXEnabledAttribute]) == false { states.append("disabled") }
                if driverBoolean(attrs[kAXFocusedAttribute]) == true { states.append("focused") }
                if driverBoolean(attrs[kAXSelectedAttribute]) == true { states.append("selected") }
                else if !secure, attrs[kAXSelectedAttribute] != nil, try node.settable(kAXSelectedAttribute, request: request) { states.append("selectable") }
                let booleanRole = ["AXCheckBox", "AXSwitch", "AXRadioButton"].contains(role) || ["AXSwitch"].contains(subrole)
                if booleanRole && (driverBoolean(attrs[kAXValueAttribute]) == true || driverInteger(attrs[kAXValueAttribute]) == 1) { states.append("checked") }
                if let expanded = driverBoolean(attrs["AXExpanded"]) { states.append(expanded ? "expanded" : "collapsed") }
                if !secure && !["AXMenuItem", "AXMenuBarItem"].contains(role) &&
                    ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXCheckBox", "AXSwitch", "AXRadioButton", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXStepper", "AXSearchField"].contains(role),
                    try node.settable(kAXValueAttribute, request: request) { states.append("settable") }
                if !secure && ["AXSlider", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXStepper", "AXProgressIndicator"].contains(role), attrs[kAXValueAttribute] is NSNumber { states.append("float") }
                if booleanRole && driverBoolean(attrs[kAXValueAttribute]) != nil { states.append("boolean") }
                let flags = states.isEmpty ? "" : " (" + states.joined(separator: ", ") + ")"
                let label = secure ? "<redacted>" : number == 0 ? freshTitle : driverClean(attrs[kAXTitleAttribute])
                let description = driverClean(attrs[kAXDescriptionAttribute]), value = driverClean(attrs[kAXValueAttribute])
                let inlineStaticValue = role == "AXStaticText" && description.isEmpty && driverClean(attrs[kAXIdentifierAttribute]).isEmpty
                var line = String(repeating: "\t", count: depth) + "\(number)" + (role == "AXMenuBarItem" && !label.isEmpty ? "" : " \(roleName)\(flags)")
                if !label.isEmpty { line += " " + label }
                else if inlineStaticValue && !value.isEmpty { line += " " + value }
                var hasContent = !label.isEmpty || (inlineStaticValue && !value.isEmpty)
                func field(_ prefix: String, _ value: String) {
                    if !value.isEmpty { line += (hasContent ? ", " : " ") + prefix + ": " + value; hasContent = true }
                }
                field("Description", description)
                field("Help", driverClean(attrs[kAXHelpAttribute]))
                if !inlineStaticValue && !(states.contains("float") && label == value) { field("Value", value) }
                field("Details", driverClean(attrs["AXDetails"]))
                field("Placeholder", driverClean(attrs["AXPlaceholderValue"]))
                field("ID", driverClean(attrs[kAXIdentifierAttribute]))
                field("URL", driverClean(attrs[kAXURLAttribute] ?? attrs[kAXDocumentAttribute]))
                let selection = driverClean(attrs["AXSelectedText"])
                if !selection.isEmpty { field("Selected text", "`" + selection.replacingOccurrences(of: "`", with: "\\`") + "`") }
                let actions: [(label: String, action: String)] = secure || ["AXMenuItem", "AXMenuBarItem"].contains(role) ? [] : try node.secondaryActions(request)
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
                    label: secure ? "" : [label, description, role == "AXStaticText" ? value : ""].first(where: { !$0.isEmpty }) ?? "", secure: secure, root: root, secondary: secondary)
                do {
                    let (children, cutChildren) = try node.children(request, limit: max(0, 10_000 - elements.count - stack.count), cached: attrs[kAXChildrenAttribute])
                    truncated = truncated || cutChildren
                    if depth >= depthLimit { if !children.isEmpty { truncated = true } }
                    else { for child in children.reversed() { stack.append((child, depth + 1, secure, root)) } }
                } catch { truncated = true }
            } catch { truncated = true; break }
        }
        let digest = try? DriverSettleTree.read(bound.root, request: request, includeScroll: false)
        let settleTree = digest?.faulted == false ? digest : nil
        request.walkDeadline = nil
        try request.check()
        guard !elements.isEmpty else { throw DriverFault("AX_UNAVAILABLE") }
        let final = try inventory.recheck(window)
        guard final["pid"] as? Int == window["pid"] as? Int,
              let finalBounds = driverRect(final["bounds"]), let initialBounds = driverRect(window["bounds"]),
              driverSameBounds(initialBounds, finalBounds) else { throw DriverFault("IDENTITY_CHANGED") }
        if inventory.fixture == nil {
            guard bound.root.pid() == pid_t(driverInteger(window["pid"])!),
                  driverSameBounds(try bound.root.frame(request), finalBounds) else { throw DriverFault("IDENTITY_CHANGED") }
            let current = try bound.root.attributes([kAXRoleAttribute, "AXWindowNumber"], request: request)
            guard current[kAXRoleAttribute] as? String == "AXWindow" else { throw DriverFault("IDENTITY_CHANGED") }
            if let number = driverInteger(current["AXWindowNumber"]), String(number) != window["windowId"] as? String { throw DriverFault("IDENTITY_CHANGED") }
        }
        let footer = focus.map { "The focused UI element is " + $0 } ?? driverNoFocusNote
        if hasSelection { text += "\n" + driverSelectionNote }
        text += "\n" + footer
        nextRead += 1
        maps[id] = DriverReadMap(id: nextRead, processStart: window["processStart"] as! String, root: bound.root, elements: elements,
            text: text, truncated: truncated, windowIDs: inventory.observedWindowIDs(window).union([id]), settleTree: settleTree)
        if maps.count > 16, let oldest = maps.min(by: { $0.value.id < $1.value.id })?.key { maps.removeValue(forKey: oldest) }
        return ["window": window, "text": text, "readId": nextRead, "truncated": truncated,
                "elapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000]
    }

}
