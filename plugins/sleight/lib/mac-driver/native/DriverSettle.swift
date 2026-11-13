import Foundation
import ApplicationServices
import CryptoKit

struct DriverSettleOptions {
    let quietMs: Double
    let capMs: Double
    let busyCapMs: Double
    let extendForBusy: Bool
    let includeScroll: Bool
    let waitForWindow: Bool
    init(_ params: DriverObject) throws {
        func duration(_ key: String, _ fallback: Int) throws -> Double {
            guard let value = params[key] else { return Double(fallback) }
            guard let number = driverInteger(value), (1...30000).contains(number) else { throw DriverFault("INVALID_PARAMS") }
            return Double(number)
        }
        func flag(_ key: String, _ fallback: Bool) throws -> Bool {
            guard let value = params[key] else { return fallback }
            guard let flag = driverBoolean(value) else { throw DriverFault("INVALID_PARAMS") }; return flag
        }
        quietMs = try duration("quietMs", 120); capMs = try duration("capMs", 1500)
        busyCapMs = try duration("busyCapMs", 5000)
        extendForBusy = try flag("extendForBusy", true); includeScroll = try flag("includeScroll", false)
        waitForWindow = try flag("waitForWindow", false)
    }
}

enum DriverSettleNotification { case change, scroll }
struct DriverSettleProviders {
    var now: () -> Double // monotonic milliseconds
    var wait: (Double) throws -> Void
    var check: () throws -> Void
    var person: () throws -> String?
    var observe: (@escaping (DriverSettleNotification) -> Void) throws -> (() -> Void)
    var tree: () throws -> DriverSettleTree
    var capture: () throws -> String
    var primaryWindow: () throws -> String?
    var drain: () -> Void
}

private final class DriverSettleSignal {
    private let lock = NSLock()
    private var revision = 0
    func receive() { lock.lock(); revision += 1; lock.unlock() }
    func sample() -> Int { lock.lock(); defer { lock.unlock() }; return revision }
}

enum DriverSettle {
    static let pollMs = 50.0
    static let captureMs = 100.0
    static func primaryWindow(_ windows: [DriverObject], previous: Set<String>, bound: DriverObject,
                              inspect: (DriverObject) throws -> DriverObject) throws -> String? {
        var matches: [String] = []
        for window in windows {
            guard let id = window["windowId"] as? String, !previous.contains(id),
                  driverInteger(window["pid"]) == driverInteger(bound["pid"]),
                  window["processStart"] as? String == bound["processStart"] as? String else { continue }
            let attrs: DriverObject
            do { attrs = try inspect(window) }
            catch let fault as DriverFault where ["AX_UNAVAILABLE", "IDENTITY_UNVERIFIED"].contains(fault.code) { continue }
            if attrs[kAXRoleAttribute] as? String == "AXWindow", ["", "AXStandardWindow"].contains(attrs[kAXSubroleAttribute] as? String ?? ""),
               driverBoolean(attrs[kAXMainAttribute]) == true { matches.append(id) }
        }
        return matches.count == 1 ? matches[0] : nil
    }
    static func personCheck<T>(inputAdmitted: Bool, _ work: () throws -> T) throws -> T {
        do { return try work() }
        catch let fault as DriverFault where fault.disposition["reason"] as? String == "person-unknown" {
            let message = inputAdmitted ? fault.message : "Person state is unknown because the frontmost app sample timed out. No input was sent; read again."
            var refusal = DriverFault(fault.code, message, unhealthy: fault.unhealthy)
            refusal.disposition = fault.disposition
            refusal.disposition["delivery"] = inputAdmitted ? "unknown" : "not-sent"
            refusal.disposition["retry"] = inputAdmitted ? "read-first" : "safe"
            throw refusal
        }
    }
    static func run(_ options: DriverSettleOptions, baseline: DriverSettleTree? = nil, inputAdmitted: Bool = false, providers p: DriverSettleProviders) throws -> DriverObject {
        try p.check()
        let began = p.now(), signal = DriverSettleSignal()
        let stop: () -> Void
        var observing = true
        do { stop = try p.observe { event in
            if event == .change || options.includeScroll { signal.receive() }
        } } catch let fault as DriverFault where fault.code == "AX_UNAVAILABLE" { stop = {}; observing = false }
        defer { stop() }
        var revision = 0, lastChange = began, nextPoll = began
        var previous = baseline
        var sawDigestChange = false, sawNotification = false, busy = 0, peakBusy = 0, extended = false, complete = false, limited = false, faulted = false
        var image: String?, imageAt = 0.0, primary: String?
        func result(_ reason: String, _ settled: Bool, person: Bool = false, basis: String? = nil) -> DriverObject {
            var value: DriverObject = ["settled": settled, "reason": reason, "elapsedMs": max(0, p.now() - began),
                "personTookOver": person, "busyElements": peakBusy, "digestComplete": complete, "observer": observing]
            if let primary = primary { value["primaryWindowId"] = primary }
            if let basis = basis { value["quietBasis"] = basis }
            return value
        }
        func personReason() throws -> String? {
            let reason = try personCheck(inputAdmitted: inputAdmitted) {
                do { return try p.person() }
                catch { try p.check(); throw error }
            }
            try p.check()
            return reason
        }
        while true {
            try p.check()
            if let reason = try personReason() { return result(reason, false, person: true) }
            p.drain()
            var now = p.now()
            let currentRevision = signal.sample()
            if revision != currentRevision {
                revision = currentRevision; lastChange = now; sawNotification = true; image = nil
            }
            var limit = began + (extended ? max(options.capMs, options.busyCapMs) : options.capMs)
            if now >= limit { return result(extended ? "busy-cap" : "cap", false) }
            if now >= nextPoll {
                let pollBegan = now
                if options.waitForWindow && primary == nil {
                    primary = try p.primaryWindow()
                    try p.check()
                    if primary != nil { lastChange = p.now(); image = nil }
                }
                let tree = try p.tree()
                try p.check()
                if let reason = try personReason() { return result(reason, false, person: true) }
                now = p.now()
                if complete != tree.complete { lastChange = now; image = nil }
                complete = tree.complete; limited = tree.limited; faulted = tree.faulted
                let comparable = tree.complete && previous?.complete == true
                if tree.axChanged || (tree.digest != nil && previous?.digest != nil && tree.digest != previous?.digest) {
                    // Partial hashes can cover different prefixes. They restart
                    // quiet, but only two complete walks prove a digest change.
                    if tree.axChanged || comparable { sawDigestChange = true }
                    lastChange = now; image = nil
                }
                previous = tree
                if tree.busyElements != busy {
                    lastChange = now; image = nil
                    if comparable { sawDigestChange = true }
                }
                busy = tree.busyElements; peakBusy = max(peakBusy, busy)
                if busy > 0 && options.extendForBusy { extended = true }
                nextPoll = max(pollBegan + pollMs, now + 0.001)
            }
            limit = began + (extended ? max(options.capMs, options.busyCapMs) : options.capMs)
            p.drain(); try p.check()
            if let reason = try personReason() { return result(reason, false, person: true) }
            now = p.now()
            if signal.sample() != revision { continue }
            if now >= limit { return result(extended ? "busy-cap" : "cap", false) }
            let windowReady = !options.waitForWindow || primary != nil
            let notificationOnly = !complete && limited && !faulted && observing
            let canSettle = complete || notificationOnly
            if canSettle && busy == 0 && windowReady && now - lastChange >= options.quietMs {
                if complete && sawDigestChange { return result("quiet", true, basis: "digest") }
                if sawNotification { return result("quiet", true, basis: "notification") }
                // With no notification, try visual evidence before relying on a
                // budget-limited observer alone. Other capture errors propagate.
                if image == nil || now - imageAt >= captureMs {
                    let captured: String
                    do { captured = try p.capture() }
                    catch let fault as DriverFault where fault.code == "SCREEN_RECORDING_REQUIRED" && notificationOnly {
                        p.drain(); try p.check()
                        if let reason = try personReason() { return result(reason, false, person: true) }
                        now = p.now()
                        if now >= limit { return result(extended ? "busy-cap" : "cap", false) }
                        if signal.sample() != revision { image = nil; continue }
                        return result("quiet", true, basis: "notification-none")
                    }
                    p.drain(); try p.check()
                    if let reason = try personReason() { return result(reason, false, person: true) }
                    now = p.now()
                    if now >= limit { return result(extended ? "busy-cap" : "cap", false) }
                    if signal.sample() != revision { image = nil; continue }
                    if let image = image, image == captured { return result("matching-captures", true, basis: "captures") }
                    if image != nil { lastChange = now }
                    image = captured; imageAt = now
                }
            }
            now = p.now()
            var until = min(nextPoll, limit)
            if canSettle && busy == 0 && windowReady {
                let quietAt = lastChange + options.quietMs
                if quietAt > now { until = min(until, quietAt) }
                else if image != nil && imageAt + captureMs > now { until = min(until, imageAt + captureMs) }
            }
            try p.wait(min(20, max(0.001, until - now)))
        }
    }
}

let driverSettleLineKeys = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute,
    kAXEnabledAttribute, kAXFocusedAttribute, "AXElementBusy"]
let driverReuseLineKeys = Array(driverSettleLineKeys.dropLast()) + [kAXSelectedAttribute, "AXElementBusy"]
let driverReuseExtraKeys = [kAXIdentifierAttribute, kAXHelpAttribute, kAXURLAttribute, kAXDocumentAttribute,
    "AXExpanded", "AXPlaceholderValue", "AXSelectedText", "AXDetails"]
let driverReuseValueRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXCheckBox",
    "AXSwitch", "AXRadioButton", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXStepper", "AXSearchField"]

// The same encoding is fed from the actual rendered walk and the bounded
// digest. Bracketing digests alone cannot detect a silent change and reversion
// while the intervening walk prints a transient value.
func driverReuseHash(_ value: Any?, into hash: inout SHA256) {
    let kind: String
    if value is String { kind = "s" }
    else if let number = value as? NSNumber { kind = CFGetTypeID(number) == CFBooleanGetTypeID() ? "b" : "n" }
    else { kind = value is URL ? "u" : "-" }
    let data = Data(driverClean(value).utf8)
    hash.update(data: Data(kind.utf8)); hash.update(data: Data("\(data.count):".utf8)); hash.update(data: data)
}

func driverReuseNodeHash(role: String, subrole: String, attributes: DriverObject, valueSettable: Bool,
                         selectedSettable: Bool, actions: [(label: String, action: String)], frame: CGRect?,
                         children: Int, into hash: inout SHA256) {
    driverReuseHash(role, into: &hash); driverReuseHash(subrole, into: &hash)
    for key in driverReuseLineKeys + driverReuseExtraKeys { driverReuseHash(attributes[key], into: &hash) }
    driverReuseHash(valueSettable, into: &hash); driverReuseHash(selectedSettable, into: &hash)
    if !["AXMenuItem", "AXMenuBarItem"].contains(role) {
        driverReuseHash(actions.count, into: &hash)
        for action in actions { driverReuseHash(action.label, into: &hash); driverReuseHash(action.action, into: &hash) }
    }
    driverReuseHash(frame != nil, into: &hash)
    if let frame = frame { for n in [frame.minX, frame.minY, frame.width, frame.height] { driverReuseHash(n, into: &hash) } }
    driverReuseHash(children, into: &hash)
}

// Only a bounded hash is retained with a read, never the digested values.
// Secure text and its descendants remain opaque.
// It is bounded independently of the model-facing tree walk.
struct DriverPersonTreeNode {
    let node: DriverNode
    let depth: Int
    let identity: String
    let digest: String
    let focused: Bool
}

struct DriverSettleTree {
    let digest: String?
    let busyElements: Int
    let complete: Bool
    var limited = false
    var faulted = false
    var axChanged = false
    var personNodes: [DriverPersonTreeNode] = []
    func matchesPersonTarget(_ after: DriverSettleTree, request: DriverRequest, map: DriverReadMap, address: Any? = nil) -> Bool {
        let beforeFocus = personNodes.filter { $0.focused }, afterFocus = after.personNodes.filter { $0.focused }
        guard beforeFocus.count == afterFocus.count,
              zip(beforeFocus, afterFocus).allSatisfy({ $0.node.same($1.node) }) else { return false }
        let args = request.params["args"] as? [Any] ?? []
        if request.method == "drag", address == nil {
            guard args.count == 2, matchesPersonTarget(after, request: request, map: map, address: args[1]) else { return false }
        }
        let value = address ?? args.first
        let target: DriverNode?
        if ["typeText", "pressKey", "modifiers"].contains(request.method) {
            guard beforeFocus.count == 1 else { return false }
            target = beforeFocus[0].node
        } else if let number = driverInteger(value) { target = map.elements[number]?.node }
        else if let selector = value as? DriverObject {
            let matches = map.elements.values.filter {
                if let id = selector["id"] as? String { return $0.identifier == id }
                if let label = selector["label"] as? String { return $0.label == label }
                return false
            }
            guard matches.count == 1 else { return false }
            target = matches[0].node
        } else {
            // Coordinate calls have no element until the post-wait hit test.
            // Retain the conservative window-region comparison for that route.
            return digest == after.digest
        }
        guard let target = target,
              let index = personNodes.firstIndex(where: { $0.node.same(target) }),
              after.personNodes.count > index else { return false }
        // Identity/numbering through the target remains bound. Values in other
        // fields are excluded, so a person's typing there does not stale a click.
        for i in 0...index {
            guard personNodes[i].node.same(after.personNodes[i].node),
                  personNodes[i].identity == after.personNodes[i].identity else { return false }
        }
        var end = index + 1
        while end < personNodes.count && personNodes[end].depth > personNodes[index].depth { end += 1 }
        var afterEnd = index + 1
        while afterEnd < after.personNodes.count && after.personNodes[afterEnd].depth > after.personNodes[index].depth { afterEnd += 1 }
        guard end == afterEnd else { return false }
        return (index..<end).allSatisfy {
            personNodes[$0].node.same(after.personNodes[$0].node) && personNodes[$0].digest == after.personNodes[$0].digest
        }
    }
    static func read(_ root: DriverNode, request: DriverRequest, includeScroll: Bool,
                     forReuse: Bool = false, menu: DriverNode? = nil) throws -> DriverSettleTree {
        let oldDeadline = request.walkDeadline
        request.walkDeadline = min(oldDeadline ?? request.deadline, request.deadline, ProcessInfo.processInfo.systemUptime + 0.04)
        defer { request.walkDeadline = oldDeadline }
        var hash = SHA256(), busy = 0, count = 0, complete = true, limited = false, faulted = false, axChanged = false
        var visited = Set<DriverSettleNodeKey>()
        var personNodes: [DriverPersonTreeNode] = []
        func feed(_ value: Any?) {
            if forReuse { driverReuseHash(value, into: &hash); return }
            let data = Data(driverClean(value).utf8)
            hash.update(data: Data("\(data.count):".utf8)); hash.update(data: data)
        }
        func hasTime() -> Bool {
            guard ProcessInfo.processInfo.systemUptime < request.walkDeadline! else { complete = false; limited = true; return false }
            return true
        }
        func walk(_ node: DriverNode, depth: Int, hidden: Bool) throws {
            try request.check()
            guard count < 3000, depth <= 64 else { complete = false; limited = true; return }
            guard hasTime() else { return }
            guard visited.insert(DriverSettleNodeKey(node: node)).inserted else { complete = false; return }
            if forReuse, node.pid() != root.pid() { complete = false; faulted = true; return }
            count += 1
            let identity = try node.attributes([kAXRoleAttribute, kAXSubroleAttribute, "AXHidden"], request: request, strict: forReuse)
            let role = identity[kAXRoleAttribute] as? String ?? ""
            let subrole = identity[kAXSubroleAttribute] as? String ?? ""
            let hidden = hidden || driverBoolean(identity["AXHidden"]) == true
            if !forReuse { feed(role); feed(subrole); feed(hidden) }
            // Read role first; secure descendants are opaque too.
            if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
                if forReuse { complete = false }; return
            }
            // Document sections use parameterized/range attributes outside the
            // numbered tree. Until those have a bounded proof, always walk.
            if forReuse && (driverDocumentRoot(role, subrole) || role == "AXCanvas") { complete = false; return }
            if role == "AXScrollBar" && !includeScroll { return }
            guard hasTime() else { return }
            let personKeys = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute,
                kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXIdentifierAttribute, "AXElementBusy"]
            let attributes = try node.attributes((forReuse ? driverReuseLineKeys + driverReuseExtraKeys : personKeys) + [kAXChildrenAttribute], request: request, strict: forReuse)
            guard hasTime() else { return }
            // Missing geometry can mean an unsupported attribute, a per-attribute
            // error or a node dying mid-walk. Keep visiting descendants, but never
            // let that ambiguity establish a complete digest or change evidence.
            let frame: CGRect?
            do { frame = try node.frame(request) }
            catch let fault as DriverFault where fault.code == "STALE_ELEMENT" {
                frame = nil; complete = false; faulted = true
            }
            if !hidden, let frame = frame, (frame.width > 0 && frame.height > 0) &&
                (role == "AXProgressIndicator" || driverBoolean(attributes["AXElementBusy"]) == true) { busy += 1 }
            var children: [DriverNode], more: Bool
            if forReuse {
                (children, more) = try node.children(request, limit: max(0, 3000 - count), cached: attributes[kAXChildrenAttribute])
                var valueSettable = false, selectedSettable = false
                if driverReuseValueRoles.contains(role) { valueSettable = try node.settable(kAXValueAttribute, request: request, strict: true) }
                if attributes[kAXSelectedAttribute] != nil && driverBoolean(attributes[kAXSelectedAttribute]) != true {
                    selectedSettable = try node.settable(kAXSelectedAttribute, request: request, strict: true)
                }
                let actions = ["AXMenuItem", "AXMenuBarItem"].contains(role) ? [] : try node.secondaryActions(request, strict: true)
                driverReuseNodeHash(role: role, subrole: subrole, attributes: attributes, valueSettable: valueSettable,
                    selectedSettable: selectedSettable, actions: actions, frame: frame, children: children.count, into: &hash)
            } else {
                for key in driverSettleLineKeys { feed(attributes[key]) }
                feed(frame != nil)
                if let frame = frame { for n in [frame.minX, frame.minY, frame.width, frame.height] { feed(n) } }
                guard hasTime() else { return }
                // These hashes retain no text. Only the addressed subtree's value
                // participates in post-wait admission; focus is checked separately.
                func fingerprint(_ keys: [String]) -> String {
                    var parts = [role, subrole, String(hidden)]
                    for key in keys { let value = driverClean(attributes[key]); parts.append("\(value.utf8.count):" + value) }
                    parts.append(frame.map { "\($0.minX):\($0.minY):\($0.width):\($0.height)" } ?? "no-frame")
                    return SHA256.hash(data: Data(parts.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
                }
                var identityKeys = [kAXTitleAttribute, kAXDescriptionAttribute, kAXEnabledAttribute, kAXFocusedAttribute, kAXSelectedAttribute, kAXIdentifierAttribute]
                if !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) { identityKeys.append(kAXValueAttribute) }
                personNodes.append(DriverPersonTreeNode(node: node, depth: depth, identity: fingerprint(identityKeys),
                    digest: fingerprint(identityKeys + [kAXValueAttribute]), focused: driverBoolean(attributes[kAXFocusedAttribute]) == true))
                (children, more) = try node.children(request, limit: max(0, 3000 - count), cached: attributes[kAXChildrenAttribute])
                feed(children.count)
            }
            if forReuse { guard hasTime() else { return } }
            if more { complete = false; limited = true }
            for child in children { try walk(child, depth: depth + 1, hidden: hidden) }
        }
        do {
            try walk(root, depth: 0, hidden: false)
            if forReuse, let menu = menu { feed("menu-root"); try walk(menu, depth: 0, hidden: false) }
        }
        catch let fault as DriverFault where ["AX_UNAVAILABLE", "STALE_ELEMENT"].contains(fault.code) {
            complete = false; faulted = true; axChanged = fault.code == "STALE_ELEMENT"
        }
        // A final AX call may finish after its slice without another node to
        // trigger timeout(). Such a walk is still incomplete.
        try request.check()
        if ProcessInfo.processInfo.systemUptime >= request.walkDeadline! { complete = false }
        return DriverSettleTree(digest: count == 0 ? nil : hash.finalize().map { String(format: "%02x", $0) }.joined(), busyElements: busy, complete: complete, limited: limited, faulted: faulted, axChanged: axChanged, personNodes: personNodes)
    }
}

struct DriverReadObservationResult {
    let observer: DriverReadObservation?
    var timedOut = false
}

// A late registration owns its cleanup, but cannot publish a reusable proof.
private final class DriverReadRegistration {
    let ready = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var expired = false
    private var observer: DriverReadObservation?
    func finish(_ value: DriverReadObservation?, deadline: Double) {
        lock.lock()
        if !expired && ProcessInfo.processInfo.systemUptime < deadline { observer = value }
        lock.unlock()
        ready.signal()
    }
    func take(deadline: Double) -> DriverReadObservationResult {
        _ = ready.wait(timeout: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime))
        lock.lock(); defer { lock.unlock() }
        expired = true
        let timedOut = ProcessInfo.processInfo.systemUptime >= deadline
        let value = timedOut ? nil : observer
        observer = nil
        return DriverReadObservationResult(observer: value, timedOut: timedOut)
    }
}

// AX registration and removal never run on the main thread. The main loop
// owns only source removal, retaining the callback owner until it is detached.
final class DriverReadObservation {
    private static let queue = DispatchQueue(label: "sleight.read-observer")
    let sample: () -> Int
    let geometryCoverage: Bool
    private let stop: () -> Void
    init(sample: @escaping () -> Int, stop: @escaping () -> Void = {}, geometryCoverage: Bool = false) {
        self.sample = sample; self.stop = stop; self.geometryCoverage = geometryCoverage
    }
    deinit { stop() }
    static func register(deadline: Double,
                         enqueue: (@escaping () -> Void) -> Void = { queue.async(execute: $0) },
                         create: @escaping () -> DriverReadObservation?) -> DriverReadObservationResult {
        let pending = DriverReadRegistration()
        enqueue {
            guard ProcessInfo.processInfo.systemUptime < deadline else { pending.finish(nil, deadline: deadline); return }
            pending.finish(create(), deadline: deadline)
        }
        return pending.take(deadline: deadline)
    }
    static func start(_ bound: DriverBoundWindow, deadline: Double) -> DriverReadObservationResult {
        guard bound.root.ax != nil else { return DriverReadObservationResult(observer: nil) }
        return register(deadline: deadline) {
            let signal = DriverSettleSignal()
            let observer = DriverSettleObserver(receive: { _ in signal.receive() }, includeScroll: true)
            do {
                try observer.start(bound, deadline: deadline, attach: false)
                // App-only registration is not a verified window observer.
                guard observer.registrations.contains(where: { CFEqual($0.0, bound.root.ax!) }) else {
                    observer.stop(); return nil
                }
                observer.attach(CFRunLoopGetMain())
                return DriverReadObservation(sample: { signal.sample() }, stop: {
                    DispatchQueue.main.async {
                        observer.detach()
                        queue.async { observer.stop() }
                    }
                }, geometryCoverage: observer.geometryCoverage)
            } catch { observer.stop(); return nil }
        }
    }
}

struct DriverReadReuse {
    let observer: DriverReadObservation
    let revision: Int
    let digest: String
    let bounds: CGRect
    let rootFrame: CGRect
    let rootRole: String
    let result: DriverObject
    func matches(_ tree: DriverSettleTree?, before: Int, after: Int) -> Bool {
        before == revision && after == revision && tree?.complete == true && tree?.faulted == false && tree?.digest == digest
    }
}

// CFHash and CFEqual agree for AXUIElement proxies. Hash collisions still use
// full node equality, so neither a collision nor a repeated proxy hides a cycle.
struct DriverSettleNodeKey: Hashable {
    let node: DriverNode
    static func == (a: Self, b: Self) -> Bool { a.node.same(b.node) }
    func hash(into hasher: inout Hasher) {
        if let ax = node.ax { hasher.combine(CFHash(ax)) }
        else { hasher.combine(node.path); hasher.combine(node.fake?["key"] as? String) }
    }
}

// AXObserver's source is owned by the current request's run loop. wait() below
// pumps that loop, including on the serial runtime queue, and defer removes it.
private final class DriverSettleObserver {
    var observer: AXObserver?
    var registrations: [(AXUIElement, CFString)] = []
    private var runLoop: CFRunLoop?
    private(set) var geometryCoverage = false
    let receive: (DriverSettleNotification) -> Void
    let includeScroll: Bool
    init(receive: @escaping (DriverSettleNotification) -> Void, includeScroll: Bool) { self.receive = receive; self.includeScroll = includeScroll }
    func start(_ bound: DriverBoundWindow, deadline: Double? = nil, attach: Bool = true) throws {
        guard let root = bound.root.ax, let pid = bound.root.pid() else { throw DriverFault("AX_UNAVAILABLE") }
        var value: AXObserver?
        let status = AXObserverCreate(pid, { _, element, notification, context in
            guard let context = context else { return }
            let owner = Unmanaged<DriverSettleObserver>.fromOpaque(context).takeUnretainedValue()
            // Persistent read observers count every event. Their callbacks do
            // no AX reads, including while a retained map awaits eviction.
            if owner.includeScroll { owner.receive(.change); return }
            let name = notification as String
            var role: CFTypeRef?
            AXUIElementSetMessagingTimeout(element, 0.01)
            if name == "AXValueChanged" { AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) }
            let scroll = name == "AXScrollPositionChanged" || (role as? String) == "AXScrollBar"
            owner.receive(scroll ? .scroll : .change)
        }, &value)
        guard status == .success, let value = value else { throw DriverFault("AX_UNAVAILABLE") }
        observer = value
        let app = AXUIElementCreateApplication(pid)
        var names = ["AXValueChanged", "AXChildrenChanged", "AXFocusedUIElementChanged", "AXFocusedWindowChanged",
            "AXWindowCreated", "AXUIElementDestroyed", "AXSheetCreated", "AXMenuOpened", "AXMenuClosed",
            "AXLayoutChanged", "AXMoved", "AXResized", "AXElementBusyChanged", "AXTitleChanged"]
        if includeScroll { names.append("AXScrollPositionChanged") }
        for element in [app, root] {
            for name in names {
                if let deadline = deadline {
                    let remaining = deadline - ProcessInfo.processInfo.systemUptime
                    guard remaining > 0 else { throw DriverFault("AX_UNAVAILABLE") }
                    guard AXUIElementSetMessagingTimeout(element, Float(min(0.01, remaining))) == .success else {
                        throw DriverFault("AX_UNAVAILABLE")
                    }
                }
                let cf = name as CFString
                if AXObserverAddNotification(value, element, cf, Unmanaged.passUnretained(self).toOpaque()) == .success {
                    registrations.append((element, cf))
                }
            }
        }
        geometryCoverage = registrations.count == names.count * 2
        guard !registrations.isEmpty else { observer = nil; throw DriverFault("AX_UNAVAILABLE") }
        if let deadline = deadline, ProcessInfo.processInfo.systemUptime >= deadline { throw DriverFault("AX_UNAVAILABLE") }
        if attach { self.attach(CFRunLoopGetCurrent()) }
    }
    func attach(_ runLoop: CFRunLoop) {
        guard let observer = observer else { return }
        self.runLoop = runLoop
        CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
    }
    func detach() {
        if let runLoop = runLoop, let observer = observer {
            CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode)
        }
        runLoop = nil
    }
    func stop() {
        guard let observer = observer else { return }
        detach()
        for (element, name) in registrations { AXObserverRemoveNotification(observer, element, name) }
        registrations.removeAll(); self.observer = nil
    }
}

extension DriverRuntime {
    func registerSettleAndPerson() {
        register(method: "personState") { request, core in
            try request.keys(["windowId", "processStart"])
            let bound = try core.boundWindow(request.params, request: request)
            return try core.person.state(window: bound.window)
        }
        register(method: "settle") { request, core in
            try request.keys(["windowId", "processStart"], optional: ["quietMs", "capMs", "afterReadId", "extendForBusy", "busyCapMs", "includeScroll", "waitForWindow"])
            let options = try DriverSettleOptions(request.params)
            try core.session.checkBeforeDesktop(allowLocked: request.allowLocked)
            let bound = try core.boundWindow(request.params, request: request)
            var previousWindows = Set<String>()
            var baseline: DriverSettleTree?
            if let after = request.params["afterReadId"] {
                guard let id = driverInteger(after), id > 0, let key = request.params["windowId"] as? String,
                      let map = core.maps[key], map.id == id, map.processStart == request.params["processStart"] as? String,
                      map.root.same(bound.root) else { throw DriverFault("STALE_READ") }
                previousWindows = map.windowIDs
                if !options.includeScroll { baseline = map.settleTree }
            }
            if options.waitForWindow && previousWindows.isEmpty { throw DriverFault("INVALID_PARAMS") }
            let watch = try DriverSettle.personCheck(inputAdmitted: request.inputAdmitted) {
                do { return try core.personWatch(request, window: bound.window) }
                catch { try request.check(); throw error }
            }
            let capture = DriverWindowCaptureBackend()
            func bind() throws -> DriverBoundWindow {
                let current = try core.boundWindow(request.params, request: request)
                guard current.root.same(bound.root), let a = driverRect(current.window["bounds"]),
                      let b = driverRect(bound.window["bounds"]), driverSameBounds(a, b) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
                return current
            }
            var result = try DriverSettle.run(options, baseline: baseline, inputAdmitted: request.inputAdmitted, providers: DriverSettleProviders(
                now: { ProcessInfo.processInfo.systemUptime * 1000 },
                wait: { ms in
                    let until = ProcessInfo.processInfo.systemUptime + ms / 1000
                    CFRunLoopRunInMode(.defaultMode, ms / 1000, false)
                    // An unavailable observer leaves the run loop with no
                    // source. CF then returns immediately; retain the poll delay.
                    let remaining = until - ProcessInfo.processInfo.systemUptime
                    if remaining > 0 { Thread.sleep(forTimeInterval: remaining) }
                },
                check: { try request.check(); try core.session.checkBeforeDesktop(allowLocked: request.allowLocked) },
                person: { try watch.check() }, observe: { receive in
                    if core.inventory.fixture != nil { throw DriverFault("AX_UNAVAILABLE") }
                    let observer = DriverSettleObserver(receive: receive, includeScroll: options.includeScroll)
                    try observer.start(bound)
                    return { observer.stop() }
                }, tree: { try DriverSettleTree.read(bind().root, request: request, includeScroll: options.includeScroll) },
                capture: {
                    guard core.inventory.fixture == nil else { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
                    let before = try DriverCaptureTarget(bind().window)
                    let image = try capture.capture(before, request: request)
                    guard before.matches(image.target), before.matches(try DriverCaptureTarget(bind().window)),
                          let data = image.image.dataProvider?.data else { throw DriverFault("CAPTURE_UNAVAILABLE") }
                    var hash = SHA256(); hash.update(data: Data("\(image.image.width):\(image.image.height):\(image.image.bytesPerRow):".utf8))
                    hash.update(data: data as Data)
                    return hash.finalize().map { String(format: "%02x", $0) }.joined()
                }, primaryWindow: {
                    let windows = core.inventory.state()["windows"] as? [DriverObject] ?? []
                    return try DriverSettle.primaryWindow(windows, previous: previousWindows, bound: bound.window) { window in
                        let candidate = try core.boundWindow(window, request: request, known: window)
                        return try candidate.root.attributes([kAXRoleAttribute, kAXSubroleAttribute, kAXMainAttribute], request: request)
                    }
                }, drain: { CFRunLoopRunInMode(.defaultMode, 0, false) }))
            result["window"] = try bind().window
            return result
        }
    }
}
