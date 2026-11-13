import AppKit
import ApplicationServices
import Carbon

struct DriverFocusSnapshot {
    let pid: Int32
    let processStart: String
    let window: CFTypeRef?
    func same(_ other: DriverFocusSnapshot) -> Bool {
        guard pid == other.pid, processStart == other.processStart else { return false }
        if let window = window, let otherWindow = other.window { return CFEqual(window, otherWindow) }
        return window == nil && other.window == nil
    }
}

struct DriverFocusFault: Error {
    let cause: Error
    let unhealthy: Bool
    let focusChanged: Bool
    let focusRestored: Bool
    let fakeActiveMs: Double
    var beliefUnconfirmed = false
}

// The closures are the OS boundary. Creating this provider never samples or posts.
struct DriverFocusProviders {
    var secureInput: () -> Bool
    var heldModifiers: () -> UInt64
    var snapshot: (Double) throws -> DriverFocusSnapshot
    var belief: (Int32, Double) throws -> Bool
    var makeEvent: (Bool) throws -> (Int32) throws -> Void
    var now: () -> Double
    var pause: (Double) -> Void
    var restore: (DriverFocusSnapshot, Int32, Double) throws -> Bool
    var frontmost: () throws -> DriverFocusSnapshot
    var personInputSince: (Double) -> Bool

    static func frontmost() throws -> DriverFocusSnapshot {
        guard let app = NSWorkspace.shared.frontmostApplication, let start = start(app), !app.isTerminated else {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=frontmost")
        }
        return DriverFocusSnapshot(pid: app.processIdentifier, processStart: start, window: nil)
    }
    static func personInputSince(_ started: Double) -> Bool {
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let quiet = [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .flagsChanged].map {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0)
        }.min() ?? 0
        return elapsed < 0 || !quiet.isFinite || quiet < elapsed
    }

    static func start(_ app: NSRunningApplication) -> String? {
        app.launchDate.map { String($0.timeIntervalSince1970) }
    }
    static func messagingBudget(_ budget: Double) -> Double {
        // AX's default is 6 s; live focus reads measured 0.2 to 12 ms. Allow
        // 100 ms for scheduling variance, bounded again by the caller's budgets.
        min(0.1, budget)
    }
    static func snapshot(_ budget: Double) throws -> DriverFocusSnapshot {
        guard budget.isFinite, budget > 0 else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=snapshot-budget") }
        guard let app = NSWorkspace.shared.frontmostApplication, let start = start(app), !app.isTerminated else {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=frontmost")
        }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, Float(messagingBudget(budget)))
        var window: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(ax, kAXFocusedWindowAttribute as CFString, &window)
        guard status == .success || status == .noValue || status == .attributeUnsupported else {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", status == .cannotComplete
                ? "KEY_FOCUS_UNAVAILABLE step=snapshot-timeout" : "KEY_FOCUS_UNAVAILABLE step=snapshot-read")
        }
        guard window == nil || CFGetTypeID(window!) == AXUIElementGetTypeID() else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=snapshot-type") }
        return DriverFocusSnapshot(pid: app.processIdentifier, processStart: start, window: window)
    }
    static func activationEvent(_ active: Bool, source: CGEventSource) throws -> CGEvent {
        let subtype: NSEvent.EventSubtype = active ? .applicationActivated : .applicationDeactivated
        guard let event = NSEvent.otherEvent(with: .appKitDefined, location: .zero, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil,
            subtype: subtype.rawValue, data1: 0, data2: 0), let cg = event.cgEvent else {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=activation-event")
        }
        cg.setSource(source)
        guard let back = NSEvent(cgEvent: cg), back.type == .appKitDefined, back.subtype == subtype else {
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=activation-roundtrip")
        }
        return cg
    }
    static var system: DriverFocusProviders {
        var source: CGEventSource?
        return DriverFocusProviders(
            secureInput: { IsSecureEventInputEnabled() },
            heldModifiers: { CGEventSource.flagsState(.hidSystemState).rawValue },
            snapshot: snapshot,
            belief: { pid, budget in
                guard budget.isFinite, budget > 0 else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=belief-budget") }
                let app = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(app, Float(messagingBudget(budget)))
                var value: CFTypeRef?
                let status = AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &value)
                guard status == .success else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", status == .cannotComplete
                    ? "KEY_FOCUS_UNAVAILABLE step=belief-timeout" : "KEY_FOCUS_UNAVAILABLE step=belief-read") }
                guard let value = value, CFGetTypeID(value) == CFBooleanGetTypeID() else {
                    throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=belief-type")
                }
                return CFEqual(value, kCFBooleanTrue)
            },
            makeEvent: { active in
                if source == nil { source = CGEventSource(stateID: .privateState) }
                guard let source = source else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=source") }
                let cg = try activationEvent(active, source: source)
                return { pid in
                    cg.timestamp = DispatchTime.now().uptimeNanoseconds
                    cg.postToPid(pid)
                }
            },
            now: { ProcessInfo.processInfo.systemUptime }, pause: { Thread.sleep(forTimeInterval: $0) },
            restore: { previous, target, started in
                // Restore only our accidental activation. HID mouse and keyboard
                // input both preserve the person's choice of frontmost app.
                let elapsed = ProcessInfo.processInfo.systemUptime - started
                guard elapsed >= 0, elapsed < 600, !personInputSince(started),
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == target,
                      let app = NSRunningApplication(processIdentifier: previous.pid), !app.isTerminated,
                      start(app) == previous.processStart else { return false }
                guard app.activate(options: []) else { return false }
                let until = ProcessInfo.processInfo.systemUptime + 0.1
                repeat {
                    if let current = NSWorkspace.shared.frontmostApplication,
                       current.processIdentifier == previous.pid, start(current) == previous.processStart { return true }
                    Thread.sleep(forTimeInterval: 0.01)
                } while ProcessInfo.processInfo.systemUptime < until
                return false
            }, frontmost: frontmost, personInputSince: personInputSince)
    }
}

final class DriverFocusBelief {
    let providers: DriverFocusProviders
    let trace: (DriverObject) -> Void
    init(providers: DriverFocusProviders = .system, trace: @escaping (DriverObject) -> Void = { record in
        if var data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
            data.append(10); FileHandle.standardError.write(data)
        }
    }) { self.providers = providers; self.trace = trace }
    func preflight() throws {
        if providers.secureInput() { throw DriverFault("SECURE_INPUT_ACTIVE") }
        // Caps Lock is a toggle, not evidence of a physically held modifier.
        let mask: UInt64 = 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x800000
        if providers.heldModifiers() & mask != 0 { throw DriverFault("PERSON_HOLDS_MODIFIER") }
    }
    func restoreAfterAction(_ previous: DriverFocusSnapshot, pid: Int32, started: Double,
                            attempted: Bool, budget: Double) throws -> (changed: Bool, restored: Bool, snapshotFailed: Bool) {
        let final: DriverFocusSnapshot?
        var snapshotFailed = false
        do { final = try providers.snapshot(DriverFocusProviders.messagingBudget(budget)) }
        catch { final = nil; snapshotFailed = true }
        // A missing focused-window sample is unproved, even if process identity
        // alone is sufficient to restore an accidental activation.
        let changed = snapshotFailed || final?.same(previous) != true
        guard attempted, final == nil || final?.pid == pid, previous.pid != pid, !providers.personInputSince(started) else {
            return (changed, false, snapshotFailed)
        }
        var current = try? providers.frontmost()
        if current == nil {
            providers.pause(0.02)
            current = try? providers.frontmost()
        }
        // The restore closure rechecks the target and the recorded original
        // process. A failed advisory sample must not strand our activation.
        let sameProcess = current.map { $0.pid == pid && (final == nil || $0.processStart == final?.processStart) } ?? true
        let restored = sameProcess && !providers.personInputSince(started) ? try providers.restore(previous, pid, started) : false
        return (changed, restored, snapshotFailed)
    }

    func run(pid: Int32, check: @escaping () throws -> Void, identity: @escaping () throws -> Void,
             remaining: @escaping () -> Double = { 30 },
             guardCost: @escaping (Double) -> Void = { _ in },
             cleanupCost: (Double) -> Void = { _ in },
             cleanupReserve: @escaping () -> Double = { 0.02 },
             projection: () -> DriverObject = { [:] },
             admit: () throws -> Void = {},
             body: (_ guardInput: () throws -> Void, _ fakeActiveMs: () -> Double) throws -> DriverObject) throws -> DriverObject {
        try preflight()
        let started = providers.now(), previous = try providers.snapshot(remaining())
        let needsBelief = previous.pid != pid
        // Both allocations precede the first post. Restoration is available even
        // when activation delivery throws after accepting its event.
        let activate = needsBelief ? try providers.makeEvent(true) : nil
        let deactivate = needsBelief ? try providers.makeEvent(false) : nil
        var attempted = false, changed = false, restored = false, unhealthy = false
        var establishingBelief = false
        var failure: Error?, result: DriverObject = [:]
        var waitEnd: Double?
        var activeStarted: Double?, activeEnded: Double?
        var guardMs = 0.0, snapshotMs = 0.0, beliefMs = 0.0, restoreMs = 0.0
        var checkMs = 0.0, identityMs = 0.0, preflightMs = 0.0, guardCount = 0, largestActiveIdentityMs = 0.0
        func sample<T>(_ total: inout Double, _ body: () throws -> T) rethrows -> T {
            let began = providers.now()
            defer { total += max(0, (providers.now() - began) * 1000) }
            return try body()
        }
        func elapsed() -> Double {
            guard let start = activeStarted else { return 0 }
            return max(0, (activeEnded ?? providers.now()) - start)
        }
        func checkInterval() throws {
            if elapsed() > 0.4 { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=active-interval") }
        }
        func readBudget(until: Double? = nil, cleaning: Bool = false) -> Double {
            let now = providers.now()
            // Ordinary guards leave the measured cleanup reserve intact. During
            // cleanup the remaining interval is that reserve, consumed per read.
            let reserve = cleaning ? 0 : max(0.02, cleanupReserve(), largestActiveIdentityMs / 1000 + 0.02)
            let activeBudget = activeStarted.map { max(0, $0 + 0.4 - now - reserve) } ?? remaining()
            return DriverFocusProviders.messagingBudget(min(remaining(), activeBudget, until.map { max(0, $0 - now) } ?? remaining()))
        }
        func observe(_ budget: Double) throws {
            if !(try sample(&snapshotMs, { try providers.snapshot(budget) })).same(previous) { changed = true }
        }
        let guardInput = {
            let began = self.providers.now()
            defer {
                // The initial bind runs before fake activation and is not a post cost.
                if activeStarted != nil { guardCost(max(0, (self.providers.now() - began) * 1000)) }
            }
            try checkInterval()
            guardCount += 1
            try sample(&guardMs) {
                try sample(&checkMs) { try check() }
                let identityBegan = self.providers.now()
                try sample(&identityMs) { try identity() }
                if activeStarted != nil {
                    largestActiveIdentityMs = max(largestActiveIdentityMs, (self.providers.now() - identityBegan) * 1000)
                }
                try sample(&preflightMs) { try self.preflight() }
            }
            // A guard can itself stall. Report the interval cap before asking
            // an AX provider to sample with a budget that is already exhausted.
            try checkInterval()
            try observe(readBudget(until: waitEnd))
            try checkInterval()
            if changed || self.providers.personInputSince(started) { throw DriverFault("PERSON_TOOK_OVER") }
        }
        do {
            try guardInput()
            if let activate = activate {
                establishingBelief = true
                try admit(); attempted = true; activeStarted = providers.now(); try activate(pid)
                let end = providers.now() + 0.15
                waitEnd = end
                while true {
                    try guardInput()
                    let believed = try sample(&beliefMs) { try providers.belief(pid, readBudget(until: end)) }
                    try checkInterval()
                    guard providers.now() <= end else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=belief-deadline") }
                    if believed { break }
                    guard providers.now() < end else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=belief") }
                    providers.pause(max(0, min(0.01, end - providers.now())))
                }
                waitEnd = nil
                establishingBelief = false
            }
            // Start with a 20 ms estimate and retain measured cleanup across
            // intervals. Every cleanup read also has a fresh hard interval bound.
            cleanupCost(largestActiveIdentityMs + 20)
            result = try body(guardInput, { elapsed() * 1000 })
            try checkInterval()
        } catch { failure = error }
        let cleanupStarted = providers.now()
        if attempted, let deactivate = deactivate {
            do {
                // Deactivate even after takeover/deadline, with identity intact.
                try identity(); try deactivate(pid)
                let end = providers.now() + 0.15
                while true {
                    // Always attempt deactivation above, even after a stall. A
                    // final bounded sample can still prove cleanup succeeded.
                    try observe(readBudget(until: end, cleaning: true))
                    let believed: Bool
                    do {
                        believed = try sample(&beliefMs) { try providers.belief(pid, readBudget(until: end, cleaning: true)) }
                    } catch let fault as DriverFault where fault.code == "KEY_FOCUS_UNAVAILABLE" && fault.message == "KEY_FOCUS_UNAVAILABLE step=belief-timeout" {
                        // cannotComplete can be transient. Retry clear timeouts
                        // within the original poll, call and interval ends.
                        try checkInterval()
                        let left = min(remaining(), end - providers.now(), activeStarted! + 0.4 - providers.now())
                        guard left > 0 else { throw fault }
                        providers.pause(min(0.01, left))
                        continue
                    }
                    if !believed && providers.now() <= end { activeEnded = providers.now(); break }
                    try checkInterval()
                    guard providers.now() < end else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=clear-belief", unhealthy: true) }
                    providers.pause(max(0, min(0.01, remaining(), end - providers.now(), activeStarted! + 0.4 - providers.now())))
                }
            } catch { unhealthy = true; if failure == nil { failure = error } }
        }
        do { try checkInterval() } catch { if failure == nil { failure = error } }
        let fakeActiveMs = elapsed() * 1000
        do {
            let budget = activeEnded == nil ? readBudget(cleaning: true) : DriverFocusProviders.messagingBudget(remaining())
            let final = try sample(&restoreMs) { try restoreAfterAction(previous, pid: pid, started: started, attempted: attempted, budget: budget) }
            changed = changed || final.changed; restored = final.restored
            if final.snapshotFailed { unhealthy = true; if failure == nil { failure = DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=restore") } }
        } catch { unhealthy = true; if failure == nil { failure = error } }
        if attempted {
            let cleanupMs = max(0, (providers.now() - cleanupStarted) * 1000)
            cleanupCost(cleanupMs)
            var record: DriverObject = ["event": "keyboard-belief", "fakeActiveMs": fakeActiveMs, "beliefCleared": activeEnded != nil,
                "elapsedMs": max(0, (providers.now() - started) * 1000), "guardMs": guardMs,
                "snapshotMs": snapshotMs, "beliefMs": beliefMs, "restoreMs": restoreMs,
                "checkMs": checkMs, "identityMs": identityMs, "preflightMs": preflightMs, "guardCount": guardCount, "cleanupMs": cleanupMs]
            let decision = projection()
            for key in ["estimatedKeyMs", "projectedMs", "cleanupReserveMs", "finalGuardMs", "strokePosts", "yielded"] {
                record[key] = decision[key]
            }
            if let fault = failure as? DriverFault, fault.code == "KEY_FOCUS_UNAVAILABLE" { record["fault"] = fault.message }
            trace(record)
        }
        if let failure = failure {
            throw DriverFocusFault(cause: failure, unhealthy: unhealthy || (failure as? DriverFault)?.unhealthy == true,
                focusChanged: changed, focusRestored: restored, fakeActiveMs: fakeActiveMs,
                beliefUnconfirmed: establishingBelief)
        }
        result["focusChanged"] = changed; result["focusRestored"] = restored
        result["fakeActiveMs"] = fakeActiveMs
        return result
    }
}
