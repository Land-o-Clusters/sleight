import ApplicationServices
import CryptoKit

// A bar-only digest is insufficient: an app can silently rename/disable a leaf
// without changing any bar attribute. Validate the entire printed projection.
// Capture once per read, then use those same inputs on a cache miss too. Private
// Apple/submenu descendants are never captured; only their visible counts are.
struct DriverMenuNodeRead {
    let node: DriverNode
    let roleAttrs: DriverObject
    let attrs: DriverObject
    let children: ([DriverNode], Bool)
    let submenu: [DriverNode]
    let submenuExpanded: Bool
    let submenuCount: Int
    let appleExpanded: Bool
    let selectedSettable: Bool
    let actions: [(label: String, action: String)]
    let frame: CGRect?
    let depth: Int

    func feed(_ hash: inout SHA256) {
        driverReuseNodeHash(role: roleAttrs[kAXRoleAttribute] as! String,
            subrole: roleAttrs[kAXSubroleAttribute] as? String ?? "", attributes: attrs,
            valueSettable: false, selectedSettable: selectedSettable, actions: actions,
            frame: frame, children: children.0.count, into: &hash)
    }
}

struct DriverMenuSnapshot {
    let root: DriverNode
    let pid: Int
    let processStart: String
    let requests: [String]
    let nodes: [DriverMenuNodeRead]
    let digest: String

    func matches(_ other: DriverMenuSnapshot) -> Bool {
        pid == other.pid && processStart == other.processStart && requests == other.requests &&
            root.same(other.root) && digest == other.digest && nodes.count == other.nodes.count &&
            zip(nodes, other.nodes).allSatisfy { $0.node.same($1.node) }
    }

    static func capture(_ root: DriverNode, window: DriverObject, requests: [String],
                        request: DriverRequest) throws -> DriverMenuSnapshot? {
        guard let pid = driverInteger(window["pid"]), let start = window["processStart"] as? String else { return nil }
        var nodes = [DriverMenuNodeRead](), seen = Set<DriverSettleNodeKey>(), hash = SHA256(), capturedBytes = 0
        func charge(_ bytes: Int) -> Bool {
            guard bytes <= 1_048_576 - capturedBytes else { return false }
            capturedBytes += bytes; return true
        }
        func walk(_ node: DriverNode, depth: Int, parentRole: String = "", firstBarChild: Bool = false) throws -> Bool {
            try request.check()
            guard depth <= 64, nodes.count < 3000, seen.insert(DriverSettleNodeKey(node: node)).inserted,
                  node.pid().map({ $0 == pid_t(pid) }) ?? (node.fake != nil) else { return false }
            // Role first, exactly as in the printer. A changed secure role never
            // causes even a speculative value read during cache validation.
            let roles = try node.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request, strict: true)
            guard let role = roles[kAXRoleAttribute] as? String,
                  ["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem"].contains(role),
                  roles[kAXSubroleAttribute] as? String != "AXSecureTextField" else { return false }
            guard depth == 0 ? role == "AXMenuBar" : role != "AXMenuBar",
                  parentRole != "AXMenuBar" || role == "AXMenuBarItem",
                  role != "AXMenuBarItem" || parentRole == "AXMenuBar" else { return false }
            let attrs = try node.attributes(driverMenuAttributes + [kAXChildrenAttribute, kAXPositionAttribute,
                kAXSizeAttribute, "AXElementBusy"], request: request, strict: true)
            // The printer truncates individual strings. Bound raw data before
            // accumulating a snapshot whose eventual printed rows may be small.
            let rawBytes = (Array(roles.values) + Array(attrs.values)).reduce(0) { $0 + (($1 as? String)?.utf8.count ?? 0) }
            guard charge(rawBytes) else { return false }
            let identity = driverCoordinateIdentity(roles.merging(attrs) { _, value in value },
                attributes: [kAXRoleAttribute, kAXSubroleAttribute] + driverMenuAttributes + ["AXElementBusy"])
            guard !identity.values.contains("unsupported") else { return false }
            let children = try node.children(request, limit: 3000, cached: attrs[kAXChildrenAttribute])
            guard !children.1 else { return false }
            var submenu = [DriverNode](), submenuExpanded = driverBoolean(attrs["AXExpanded"]) == true, count = 0
            var extraIdentity = [String]()
            if role == "AXMenuItem" {
                for child in children.0 {
                    let childRole = try child.attributes([kAXRoleAttribute], request: request, strict: true)[kAXRoleAttribute] as? String
                    extraIdentity.append(childRole ?? "missing")
                    if childRole == "AXMenu" {
                        submenu.append(child)
                        let expanded = try child.attributes(["AXExpanded"], request: request, strict: true)["AXExpanded"]
                        submenuExpanded = submenuExpanded || driverBoolean(expanded) == true
                        let nested = try child.children(request, limit: 10_000)
                        guard !nested.1 else { return false }
                        count += nested.0.count
                    }
                }
            }
            let apple = firstBarChild && ["", "Apple", ""].contains(driverClean(attrs[kAXTitleAttribute]))
            var appleExpanded = apple && (driverBoolean(attrs["AXExpanded"]) == true || driverBoolean(attrs[kAXSelectedAttribute]) == true)
            if apple && !appleExpanded {
                for child in children.0 {
                    let expanded = try child.attributes(["AXExpanded"], request: request, strict: true)["AXExpanded"]
                    if driverBoolean(expanded) == true { appleExpanded = true }
                }
            }
            let selectedSettable = attrs[kAXSelectedAttribute] != nil && driverBoolean(attrs[kAXSelectedAttribute]) != true
                ? try node.settable(kAXSelectedAttribute, request: request, strict: true) : false
            let actions = ["AXMenuItem", "AXMenuBarItem"].contains(role) ? [] : try node.secondaryActions(request, strict: true)
            guard actions.count <= 256, charge(actions.reduce(0) { $0 + $1.label.utf8.count + $1.action.utf8.count }) else { return false }
            let frame = try? node.frame(request, cached: attrs)
            let row = DriverMenuNodeRead(node: node, roleAttrs: roles, attrs: attrs, children: children,
                submenu: submenu, submenuExpanded: submenuExpanded, submenuCount: count,
                appleExpanded: appleExpanded, selectedSettable: selectedSettable, actions: actions, frame: frame, depth: depth)
            nodes.append(row)
            // Raw identities include absence/type and uncleaned string hashes.
            // Formatting and retained identity therefore share every input.
            let coordinates: [Double] = frame.map { [Double($0.minX), Double($0.minY), Double($0.width), Double($0.height)] } ?? []
            let fields: [Any] = [identity, depth, children.0.count, count, appleExpanded, submenuExpanded,
                selectedSettable, actions.map { [$0.label, $0.action] }, coordinates, extraIdentity]
            let bytes = try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            hash.update(data: Data("\(bytes.count):".utf8)); hash.update(data: bytes)
            let title = [driverClean(attrs[kAXTitleAttribute]), driverClean(attrs[kAXDescriptionAttribute])].first(where: { !$0.isEmpty }) ?? ""
            let requested = requests.contains { !title.isEmpty && $0.compare(title, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame }
            if apple && !appleExpanded || !submenu.isEmpty && !(requested && submenuExpanded) { return true }
            for (index, child) in children.0.enumerated() {
                if try !walk(child, depth: depth + 1, parentRole: role, firstBarChild: role == "AXMenuBar" && index == 0) { return false }
            }
            return true
        }
        guard try walk(root, depth: 0),
              ProcessInfo.processInfo.systemUptime < (request.walkDeadline ?? request.deadline) else { return nil }
        return DriverMenuSnapshot(root: root, pid: pid, processStart: start, requests: requests, nodes: nodes,
            digest: hash.finalize().map { String(format: "%02x", $0) }.joined())
    }
}

struct DriverMenuCache {
    let snapshot: DriverMenuSnapshot
    // Suffix starts after the number, so window changes can rebase all rows.
    let suffixes: [String]
    let elements: [DriverElement]
    var wasHit = false
}
