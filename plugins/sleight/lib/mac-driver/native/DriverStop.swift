import Foundation

// The authenticated reader can release input while the action queue is blocked
// in an AX read or settle. Every post and its prepared release share this lock.
// The release closures retain the original binding and recheck it before posting.
final class DriverInputRelease {
    private let lock = NSRecursiveLock()
    private var holds: [String: () throws -> Void] = [:]
    private var latched = false
    private var releaseFailed = false
    var confirmed: Bool { lock.lock(); defer { lock.unlock() }; return holds.isEmpty && !releaseFailed }
    func post(_ lane: String, release: (() throws -> Void)?, _ send: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if latched { throw DriverFault("USER_STOPPED") }
        if let release = release { holds[lane] = release }
        try send()
    }
    func retain(_ lane: String, release: @escaping () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        if latched { throw DriverFault("USER_STOPPED") }
        holds[lane] = release
    }
    func clear(_ lane: String) { lock.lock(); holds.removeValue(forKey: lane); lock.unlock() }
    func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        latched = true
        for release in holds.values {
            do { try release() } catch { releaseFailed = true }
        }
        holds.removeAll()
        return !releaseFailed
    }
    func prompt() {
        lock.lock(); defer { lock.unlock() }
        if holds.isEmpty { latched = false; releaseFailed = false }
    }
}

// Only DriverRuntime's authenticated reader changes this state. The serial
// input queue checks it through every copy of the current request.
final class DriverStopTicket {
    private let lock = NSLock()
    private var cancelled = false
    func stop() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw DriverFault("USER_STOPPED") }
    }
}
final class DriverUserStop {
    private let lock = NSLock()
    private var active: Int?
    private var queued: [Int: DriverStopTicket] = [:]
    private var latched = false
    var stopped: Bool { lock.lock(); defer { lock.unlock() }; return latched }
    func enqueue(_ call: Int) -> DriverStopTicket {
        lock.lock(); defer { lock.unlock() }
        let ticket = DriverStopTicket()
        if latched { ticket.stop() }
        queued[call] = ticket; return ticket
    }
    func begin(_ call: Int) { lock.lock(); active = call; lock.unlock() }
    func end(_ call: Int) { lock.lock(); if active == call { active = nil }; queued.removeValue(forKey: call); lock.unlock() }
    func cancel(_ call: Int) {
        lock.lock(); defer { lock.unlock() }
        if queued[call] != nil {
            latched = true
            for ticket in queued.values { ticket.stop() }
        }
    }
    func receive(_ object: DriverObject, nonce: String) throws {
        guard object["protocol"] as? String == driverProtocol, object["platform"] as? String == "darwin",
              object["nonce"] as? String == nonce, let control = object["control"] as? String else { throw DriverFault("DRIVER_PROTOCOL") }
        switch control {
        case "release":
            guard Set(object.keys) == ["protocol", "platform", "nonce", "control"] else { throw DriverFault("DRIVER_PROTOCOL") }
            lock.lock(); latched = true
            for ticket in queued.values { ticket.stop() }
            lock.unlock()
        case "stop":
            guard Set(object.keys) == ["protocol", "platform", "nonce", "control", "call"],
                  let call = driverInteger(object["call"]), call > 0 else { throw DriverFault("DRIVER_PROTOCOL") }
            cancel(call)
        case "prompt":
            guard Set(object.keys) == ["protocol", "platform", "nonce", "control"] else { throw DriverFault("DRIVER_PROTOCOL") }
            lock.lock()
            if active == nil && queued.isEmpty { latched = false }
            lock.unlock()
        default: throw DriverFault("DRIVER_PROTOCOL")
        }
    }
}
