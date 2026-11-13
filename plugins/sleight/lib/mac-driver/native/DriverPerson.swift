import AppKit
import CoreGraphics

// Sampling only. No event tap, monitor, activation, event post or permission request.
struct DriverPersonSample {
    let at: Double
    let hidIdle: Double
    let frontmostPID: Int?
    let pointerPID: Int?
    var valid: Bool { at.isFinite && at >= 0 && hidIdle.isFinite && hidIdle >= 0 && (frontmostPID ?? 0) > 0 }
    var lastInput: Double { at - hidIdle }
    func involves(_ pid: Int) -> Bool { frontmostPID == pid || pointerPID == pid }
}

// The request thread never reads NSWorkspace's cached state itself. The main
// run loop must service a fresh read within 50 ms, otherwise the guard refuses.
private final class DriverFrontmostRead {
    let ready = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var expired = false
    private var pid: Int?
    func finish(_ read: () -> Int?) {
        lock.lock(); let shouldRead = !expired; lock.unlock()
        guard shouldRead else { return }
        let value = read()
        lock.lock(); defer { lock.unlock() }
        guard !expired else { return }
        pid = value; ready.signal()
    }
    func take(_ completed: Bool) throws -> Int {
        lock.lock(); defer { lock.unlock() }
        expired = true
        guard completed else {
            var fault = DriverFault("PERSON_TOOK_OVER", "Person state is unknown because the frontmost app sample timed out; read again.")
            fault.disposition = ["reason": "person-unknown", "personTookOver": false, "settled": false,
                "delivery": "unknown", "retry": "read-first"]
            throw fault
        }
        guard let pid = pid, pid > 0 else {
            throw DriverFault("DRIVER_INTERNAL", "Frontmost app sample is unavailable.", unhealthy: true)
        }
        return pid
    }
}

struct DriverPersonProviders {
    var sample: () throws -> DriverPersonSample
    var now: () -> Double = { ProcessInfo.processInfo.systemUptime }
    var wait: (Double) -> Void = { Thread.sleep(forTimeInterval: $0) }
    var heldModifiers: () -> UInt64 = { 0 }
    var inputSequence: () -> UInt64 = { 0 }
    static func pointerPID(rows: [DriverObject], point: CGPoint) -> Int? {
        // Keep the front-to-back match without allocating or scanning all the
        // layer-zero rows before checking the first possible pointer owner.
        rows.first { row in
            guard driverInteger(row[kCGWindowLayer as String]) == 0,
                  let rect = row[kCGWindowBounds as String] as? DriverObject,
                  let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
            return bounds.contains(point)
        }.flatMap { driverInteger($0[kCGWindowOwnerPID as String]) }
    }
    static func frontmostPID(isMainThread: Bool = Thread.isMainThread,
                             enqueue: (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
                             read: @escaping () -> Int? = { NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } }) throws -> Int {
        let value = DriverFrontmostRead()
        if isMainThread { value.finish(read); return try value.take(true) }
        enqueue { value.finish(read) }
        return try value.take(value.ready.wait(timeout: .now() + 0.05) == .success)
    }
    static var system: DriverPersonProviders {
        DriverPersonProviders(sample: {
            let front = try frontmostPID()
            let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
            let at = ProcessInfo.processInfo.systemUptime
            guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [DriverObject],
                  let point = CGEvent(source: nil)?.location else { throw DriverFault("DRIVER_INTERNAL", "Person state is unavailable.", unhealthy: true) }
            let pointer = pointerPID(rows: rows, point: point)
            return DriverPersonSample(at: at, hidIdle: idle, frontmostPID: front, pointerPID: pointer)
        }, heldModifiers: { CGEventSource.flagsState(.hidSystemState).rawValue }, inputSequence: {
            UInt64(CGEventSource.counterForEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!))
        })
    }
    // A fixture may never fall through to a live sampler.
    static var fixture: DriverPersonProviders {
        DriverPersonProviders(sample: { DriverPersonSample(at: ProcessInfo.processInfo.systemUptime,
            hidIdle: 10, frontmostPID: Int(getpid()), pointerPID: nil) })
    }
}

final class DriverPersonWatch {
    private var previous: DriverPersonSample
    private let providers: DriverPersonProviders
    private let pid: Int
    private var stopped: String?
    private var lastRelevant: Double
    private var inputChecked = false
    init(sample: DriverPersonSample, pid: Int, providers: DriverPersonProviders, fresh: Bool) {
        previous = sample; self.pid = pid; self.providers = providers
        lastRelevant = sample.involves(pid) ? sample.lastInput : -Double.infinity
        if fresh && sample.hidIdle < 0.5 && sample.involves(pid) { stopped = "person-active" }
    }
    func check(quietSeconds: Double = 0.5, beginInput: Bool = false) throws -> String? {
        let initialInput = beginInput && !inputChecked
        if beginInput { inputChecked = true }
        if let stopped = stopped { return stopped }
        let current = try providers.sample()
        guard current.valid, current.at >= previous.at else { throw DriverFault("DRIVER_INTERNAL", "Person state is unavailable.", unhealthy: true) }
        if current.involves(pid) { lastRelevant = max(lastRelevant, current.lastInput) }
        // Compare last-event timestamps, not idle magnitudes. Input can arrive
        // even when the new idle value is larger than the earlier one.
        if current.lastInput > previous.lastInput + 0.003 && (current.involves(pid) || previous.involves(pid)) {
            stopped = initialInput && current.at - lastRelevant < quietSeconds ? "person-active" : "person-took-over"
        } else if current.at - lastRelevant < quietSeconds {
            stopped = "person-active"
        }
        previous = current
        return stopped
    }
    // Only initial activity may wait. Once the caller has started its guarded
    // admission sequence, new input remains a sticky takeover.
    func waitForQuiet(remaining: () -> Double, checkpoint: () throws -> Void,
                      waiting: (Double) -> Void) throws -> Double {
        let began = providers.now()
        let cap = min(8.0, max(0, remaining() - 0.150))
        var current = previous
        guard current.involves(pid) && current.hidIdle < 1.0 || stopped == "person-active" else { return 0 }
        func refusal() -> DriverFault {
            var fault = DriverFault("PERSON_TOOK_OVER", current.pointerPID == pid
                ? "The pointer is over the target window; read again after the person moves it away."
                : "A person is active; read again after they stop.")
            fault.disposition = ["reason": current.pointerPID == pid ? "person-pointer" : "person-active",
                "personTookOver": true, "delivery": "not-sent", "retry": "safe", "settled": false]
            return fault
        }
        waiting(cap * 1000)
        while true {
            let tick = providers.now()
            guard tick - began < cap, remaining() > 0.150 else { throw refusal() }
            try checkpoint()
            current = try providers.sample()
            guard current.valid, current.at >= previous.at else { throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
            previous = current
            if current.involves(pid) { lastRelevant = max(lastRelevant, current.lastInput) }
            let elapsed = providers.now() - began
            guard elapsed < cap, remaining() > 0.150 else { throw refusal() }
            // A pointer parked after motion can still belong to a person's drag.
            // Never admit a second pointer action underneath it.
            if current.pointerPID != pid && current.at - lastRelevant >= 1.0 {
                stopped = nil
                return elapsed * 1000
            }
            providers.wait(min(max(0, tick + 0.020 - providers.now()), cap - elapsed, max(0, remaining() - 0.150)))
        }
    }
}

final class DriverPerson {
    private let providers: DriverPersonProviders
    private struct Token {
        let binding: String
        let sample: DriverPersonSample
        let reason: String?
    }
    private var tokens: [String: Token] = [:]
    private var order: [String] = []
    private var latest: [String: DriverPersonSample] = [:]
    init(providers: DriverPersonProviders = .system) { self.providers = providers }
    func heldModifiers() -> Bool { providers.heldModifiers() & 0x9e0000 != 0 }
    func now() -> Double { providers.now() }
    func inputSequence() -> UInt64 { providers.inputSequence() }
    private func binding(_ window: DriverObject) throws -> (String, Int) {
        guard let id = window["windowId"] as? String, let number = UInt32(id), number > 0, String(number) == id,
              let pid = driverInteger(window["pid"]), pid > 0, pid <= Int32.max,
              let start = window["processStart"] as? String, !start.isEmpty else { throw DriverFault("IDENTITY_UNVERIFIED") }
        return ("\(pid):\(start):\(id)", pid)
    }
    func begin(window: DriverObject, token: String? = nil) throws -> DriverPersonWatch {
        let (key, pid) = try binding(window)
        if let token = token {
            guard let baseline = tokens[token], baseline.binding == key else {
                throw DriverFault("PERSON_TOOK_OVER", "Person sample expired; read again.")
            }
            guard baseline.reason != "person-took-over" else { throw DriverFault("PERSON_TOOK_OVER", "A person took over; read again.") }
            return DriverPersonWatch(sample: baseline.sample, pid: pid, providers: providers, fresh: false)
        }
        let sample = try providers.sample()
        guard sample.valid else { throw DriverFault("DRIVER_INTERNAL", "Person state is unavailable.", unhealthy: true) }
        return DriverPersonWatch(sample: sample, pid: pid, providers: providers, fresh: true)
    }
    func state(window: DriverObject) throws -> DriverObject {
        let (key, pid) = try binding(window)
        let sample = try providers.sample()
        guard sample.valid else { throw DriverFault("DRIVER_INTERNAL", "Person state is unavailable.", unhealthy: true) }
        let previous = latest[key]
        let watch = DriverPersonWatch(sample: previous ?? sample, pid: pid,
            providers: DriverPersonProviders(sample: { sample }), fresh: previous == nil)
        let reason = try watch.check()
        let token = UUID().uuidString
        tokens[token] = Token(binding: key, sample: sample, reason: reason); order.append(token); latest[key] = sample
        if order.count > 64 { tokens.removeValue(forKey: order.removeFirst()) }
        if latest.count > 64 { latest = [key: sample] }
        return ["window": window, "personTookOver": reason != nil, "reason": reason ?? "quiet", "token": token]
    }
}

extension DriverCore {
    func personWatch(_ request: DriverRequest, window: DriverObject) throws -> DriverPersonWatch {
        if request.personWatch == nil {
            guard request.personToken == nil || request.personToken is String else { throw DriverFault("INVALID_PARAMS") }
            request.personWatch = try person.begin(window: window, token: request.personToken as? String)
        }
        return request.personWatch!
    }
    // Input registrars must call this before admission. The token comes from the
    // original request even if a settle copy initialized the shared watch first.
    func checkPersonBeforeInput(_ request: DriverRequest, window: (() throws -> DriverObject)? = nil) throws {
        guard let token = request.personToken as? String, !token.isEmpty else {
            throw DriverFault("INVALID_PARAMS", "Input requires personToken from a fresh personState read.")
        }
        let first = !request.personInputChecked
        request.personInputChecked = true
        try checkPerson(request, waitBeforeAdmission: first && !request.inputAdmitted, inputWindow: window)
    }
    // RT4/RT5 registration passes this to their per-event guard. The request
    // retains one watch across posts, delays, settle and its final read.
    func checkPerson(_ request: DriverRequest, waitBeforeAdmission: Bool = false,
                     inputWindow: (() throws -> DriverObject)? = nil) throws {
        try request.check()
        try session.checkBeforeDesktop(allowLocked: request.allowLocked)
        // Input guards rebind CG and AX visibility at every posting boundary.
        // Read/settle samples keep their metadata-only person check.
        let window = try inputWindow?() ?? (request.isAction ? boundWindow(request.params, request: request).window : inventory.bound(request.params))
        let reason: String?
        do {
            let watch = try personWatch(request, window: window)
            reason = try watch.check(quietSeconds: request.isAction ? 1.0 : 0.5, beginInput: waitBeforeAdmission)
            if reason == "person-active", waitBeforeAdmission {
                func wait() throws {
                    let began = person.now()
                    defer { request.waitedForPersonMs += max(0, (person.now() - began) * 1000) }
                    _ = try watch.waitForQuiet(remaining: { request.personWaitRemaining }, checkpoint: {
                        try request.check()
                        let state = try self.session.checkBeforeDesktop(allowLocked: request.allowLocked)
                        if !DriverPointer.methods.contains(request.method), state.secureInput { throw DriverFault("SECURE_INPUT_ACTIVE") }
                        _ = try self.boundWindow(request.params, request: request)
                    }, waiting: { cap in
                        request.personWaitCapMs = Int((cap + 0.0000001).rounded(.down))
                        request.beginPersonWait()
                        request.actionEvent?.waitingForPerson()
                    })
                }
                try wait()
                // The parent checks Pause, approval, policy and lease after the wait.
                // Native checks follow its reply, with a fresh final HID sample.
                guard request.remaining >= 0.500 else { throw DriverFault("PERSON_TOOK_OVER") }
                try request.checkParentAdmission()
                // Compare the original target and focus, excluding other fields' values.
                let fresh = try boundWindow(request.params, request: request)
                guard let oldBounds = driverRect(window["bounds"]), let newBounds = driverRect(fresh.window["bounds"]),
                      driverSameBounds(oldBounds, newBounds) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
                let state = try session.checkBeforeDesktop(allowLocked: request.allowLocked)
                if !DriverPointer.methods.contains(request.method), state.secureInput { throw DriverFault("SECURE_INPUT_ACTIVE") }
                guard !person.heldModifiers() else { throw DriverFault("PERSON_HOLDS_MODIFIER") }
                guard let id = request.params["windowId"] as? String, let map = maps[id],
                      map.id == driverInteger(request.params["readId"]), !map.truncated,
                      map.processStart == request.params["processStart"] as? String, map.root.same(fresh.root),
                      let before = map.settleTree, before.complete, before.digest != nil else { throw DriverFault("STALE_READ") }
                let after = try DriverSettleTree.read(fresh.root, request: request, includeScroll: false)
                guard after.complete, before.matchesPersonTarget(after, request: request, map: map) else { throw DriverFault("STALE_READ") }
                try request.check()
                // A final fresh person sample closes the wait-to-admission gap.
                try checkPerson(request)
                return
            }
        } catch var fault as DriverFault where fault.disposition["reason"] as? String == "person-unknown" {
            try request.check()
            fault.disposition["delivery"] = request.inputAdmitted ? "unknown" : "not-sent"
            fault.disposition["retry"] = request.inputAdmitted ? "read-first" : "safe"
            throw fault
        }
        if let reason = reason {
            var fault = DriverFault("PERSON_TOOK_OVER", reason == "person-active" ? "A person is active; read again after they stop." : "A person took over; read again.")
            fault.disposition = ["personTookOver": true, "settled": false, "reason": reason,
                "delivery": request.inputAdmitted ? "unknown" : "not-sent", "retry": request.inputAdmitted ? "read-first" : "safe"]
            throw fault
        }
    }
}
