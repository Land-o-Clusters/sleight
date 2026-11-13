import Foundation
import CoreGraphics
import IOKit.pwr_mgt
import Carbon

// Constructing these providers is inert. Tests replace the OS closures.
struct DriverSessionProviders {
    var dictionary: () -> [String: Any]?
    var hidIdle: () -> Double
    var acquireSleep: () throws -> UInt32
    var releaseSleep: (UInt32) -> Int32
    // Fixture callers that omit the new provider stay inert. Production uses
    // .system, which binds the public Carbon call below.
    var secureInput: () -> Bool = { false }

    static var system: DriverSessionProviders {
        DriverSessionProviders(
            dictionary: { CGSessionCopyCurrentDictionary() as? [String: Any] },
            hidIdle: { CGEventSource.secondsSinceLastEventType(.hidSystemState,
                       eventType: CGEventType(rawValue: UInt32.max)!) },
            acquireSleep: {
                var id = IOPMAssertionID(0)
                let status = IOPMAssertionCreateWithName(
                    kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                    IOPMAssertionLevel(kIOPMAssertionLevelOn),
                    "sleight driver request" as CFString, &id)
                guard status == kIOReturnSuccess else {
                    throw DriverFault("DRIVER_INTERNAL", "System sleep assertion could not be acquired.", unhealthy: true)
                }
                return id
            },
            releaseSleep: { IOPMAssertionRelease($0) },
            secureInput: { IsSecureEventInputEnabled() })
    }
}

struct DriverSessionSample {
    let onConsole: Bool?
    let loginDone: Bool?
    let sessionLocked: Bool?
    let hidIdleSeconds: Double?
    let secureInput: Bool

    var available: Bool {
        onConsole != nil && loginDone != nil && sessionLocked != nil && hidIdleSeconds != nil
    }

    // Unknown values remain null in health; they never masquerade as unlocked.
    var health: [String: Any] {
        ["onConsole": onConsole.map { $0 as Any } ?? NSNull(),
         "loginDone": loginDone.map { $0 as Any } ?? NSNull(),
         "sessionLocked": sessionLocked.map { $0 as Any } ?? NSNull(),
         "hidIdleSeconds": hidIdleSeconds.map { $0 as Any } ?? NSNull(),
         "secureInput": secureInput]
    }
}

// Hammerspoon documents screen lock/unlock event names (MIT),
// https://www.hammerspoon.org/docs/hs.caffeinate.watcher.html#screensDidLock
// and #screensDidUnlock. The notification strings below need the sitting log's
// confirmation. Behavior only; no Hammerspoon code is used here.
struct DriverLockEvents {
    var observe: (@escaping (Bool) -> Void) -> (() -> Void)

    static var inert: DriverLockEvents { DriverLockEvents(observe: { _ in {} }) }
    static var system: DriverLockEvents {
        DriverLockEvents(observe: { changed in
            let center = DistributedNotificationCenter.default()
            let locked = center.addObserver(forName: Notification.Name("com.apple.screenIsLocked"),
                                            object: nil, queue: nil) { _ in changed(true) }
            let unlocked = center.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"),
                                              object: nil, queue: nil) { _ in changed(false) }
            return { center.removeObserver(locked); center.removeObserver(unlocked) }
        })
    }
}

// Notification callbacks and the request worker may run on different threads.
// No desktop call runs while this mutex is held.
final class DriverLockState {
    private let mutex = NSLock()
    private var cached = false
    private var held = false
    private var firstUnlocked: Double?
    private var revision: UInt64 = 0
    private var generation: UInt64 = 0

    // Diagnostic notification flag. Admission uses held and generation, which
    // notifications also update and only fresh dictionary samples can clear.
    var cachedFlag: Bool { mutex.lock(); defer { mutex.unlock() }; return cached }
    var sampleRevision: UInt64 { mutex.lock(); defer { mutex.unlock() }; return revision }
    var lockGeneration: UInt64 { mutex.lock(); defer { mutex.unlock() }; return generation }

    func notified(_ locked: Bool) {
        mutex.lock(); defer { mutex.unlock() }
        cached = locked; held = true; firstUnlocked = nil; revision &+= 1
        if locked { generation &+= 1 }
    }

    func sampled(_ raw: Bool?, active: Bool, at time: Double, revision before: UInt64) {
        mutex.lock(); defer { mutex.unlock() }
        if raw == true {
            if !held { generation &+= 1 }
            held = true; firstUnlocked = nil
        } else if raw == false && active && before == revision {
            if held {
                if let first = firstUnlocked, time >= first + 0.1 {
                    held = false; firstUnlocked = nil
                } else if firstUnlocked == nil { firstUnlocked = time }
            }
        } else { firstUnlocked = nil }
        // A dictionary sample can discover a missed lock or unlock notification.
        // A notification cannot clear a lock without a fresh unlocked pair.
    }

    func unlockDelay(at time: Double) -> Double? {
        mutex.lock(); defer { mutex.unlock() }
        guard held, let first = firstUnlocked else { return nil }
        return min(0.1, max(0, first + 0.1 - time))
    }

    func check(since start: UInt64, allowLocked: Bool) throws {
        mutex.lock(); defer { mutex.unlock() }
        if !allowLocked && (held || generation != start) { throw DriverFault("SCREEN_LOCKED") }
    }
}

final class DriverSession {
    private let providers: DriverSessionProviders
    private let lockState = DriverLockState()
    private let now: () -> Double
    private let sleep: (Double) -> Void
    private var stopLockEvents: (() -> Void)?
    convenience init() { self.init(providers: .system, lockEvents: .system) }
    init(providers: DriverSessionProviders, lockEvents: DriverLockEvents = .inert,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         sleep: @escaping (Double) -> Void = { Thread.sleep(forTimeInterval: $0) }) {
        self.providers = providers; self.now = now; self.sleep = sleep
        stopLockEvents = lockEvents.observe { [weak self] locked in self?.lockState.notified(locked) }
    }
    deinit { stopLockEvents?() }
    var cachedLockFlag: Bool { lockState.cachedFlag }

    private func flag(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() || CFGetTypeID(number) == CFNumberGetTypeID(),
              number.doubleValue == 0 || number.doubleValue == 1 else { return nil }
        return number.boolValue
    }

    func sample() -> DriverSessionSample {
        let revision = lockState.sampleRevision
        let dictionary = providers.dictionary(), idle = providers.hidIdle()
        let onConsole = flag(dictionary?["kCGSSessionOnConsoleKey"])
        let loginDone = flag(dictionary?["kCGSessionLoginDoneKey"])
        // macOS can omit this key when unlocked. Only a readable session with
        // valid console/login flags gives absence that meaning.
        var locked: Bool?
        if let value = dictionary?["CGSSessionScreenIsLocked"] { locked = flag(value) }
        else { locked = onConsole != nil && loginDone != nil ? false : nil }
        lockState.sampled(locked, active: onConsole == true && loginDone == true,
                          at: now(), revision: revision)
        return DriverSessionSample(onConsole: onConsole, loginDone: loginDone, sessionLocked: locked,
                                   hidIdleSeconds: idle.isFinite && idle >= 0 ? idle : nil,
                                   secureInput: providers.secureInput())
    }

    // RT6 calls this immediately before input. Reads and captures use the same
    // guard. allowLocked is a validated request value, never an environment read.
    @discardableResult
    func checkBeforeDesktop(allowLocked: Bool = false) throws -> DriverSessionSample {
        let started = now()
        var state = sample()
        if !allowLocked, state.available, state.onConsole == true, state.loginDone == true,
           state.sessionLocked == false, let delay = lockState.unlockDelay(at: now()) {
            // One wait only. Notifications or an early wake cannot start another
            // wait in this call. Oversleep refuses before any desktop work.
            guard now() + delay <= started + 0.15 else { throw DriverFault("SCREEN_LOCKED") }
            if delay > 0 { sleep(delay) }
            guard now() <= started + 0.15 else { throw DriverFault("SCREEN_LOCKED") }
            state = sample()
            guard now() <= started + 0.15 else { throw DriverFault("SCREEN_LOCKED") }
        }
        try lockState.check(since: lockState.lockGeneration, allowLocked: allowLocked)
        if state.sessionLocked == true && !allowLocked { throw DriverFault("SCREEN_LOCKED") }
        guard state.available, state.onConsole == true, state.loginDone == true else {
            throw DriverFault("DRIVER_INTERNAL", "An active console session could not be verified.", unhealthy: true)
        }
        return state
    }

    // The generation catches even a lock followed by a confirmed unlock during
    // this request. Checkpoints stop further work; completion discards its result.
    func withDesktopRequest<T>(allowLocked: Bool = false,
                              _ body: (@escaping () throws -> Void) throws -> T) throws -> T {
        let generation = lockState.lockGeneration
        try checkBeforeDesktop(allowLocked: allowLocked)
        let check = { [self] in
            let state = sample()
            try lockState.check(since: generation, allowLocked: allowLocked)
            guard state.available, state.onConsole == true, state.loginDone == true else {
                throw DriverFault("DRIVER_INTERNAL", "An active console session could not be verified.", unhealthy: true)
            }
        }
        do {
            try check()
            let value = try body(check)
            try check()
            return value
        } catch {
            // Input handlers may already know delivery and cleanup details.
            // Preserve those when a concurrent lock becomes the ending reason.
            do { try check() } catch let locked as DriverFault where locked.code == "SCREEN_LOCKED" {
                var fault = locked
                if let original = error as? DriverFault {
                    fault = DriverFault("SCREEN_LOCKED", unhealthy: original.unhealthy)
                    fault.disposition = original.disposition
                }
                throw fault
            } catch { /* Preserve the handler fault when no lock was observed. */ }
            throw error
        }
    }

    // RT2 wraps admitted handler execution, including its final deadline check.
    // Each scope owns its assertion, so nesting cannot release an outer request.
    // No display assertion, activity declaration, wake or unlock operation exists.
    func withRequestPower<T>(_ body: () throws -> T) throws -> T {
        let id = try providers.acquireSleep()
        let result: Result<T, Error>
        do { result = .success(try body()) } catch { result = .failure(error) }
        guard providers.releaseSleep(id) == kIOReturnSuccess else {
            // Retire the helper if cleanup cannot be proved. Process exit also
            // releases assertions if RT2's watchdog terminates a blocked handler.
            throw DriverFault("DRIVER_INTERNAL", "System sleep assertion could not be released.", unhealthy: true)
        }
        return try result.get()
    }
}
