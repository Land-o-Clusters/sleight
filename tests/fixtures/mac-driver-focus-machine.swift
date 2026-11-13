import Foundation
import ApplicationServices

typealias DriverObject = [String: Any]
struct DriverFault: Error {
    let code: String
    let unhealthy: Bool
    let message: String
    init(_ code: String, _ message: String? = nil, unhealthy: Bool = false) { self.code = code; self.message = message ?? code; self.unhealthy = unhealthy }
}

@main struct FocusMachineFixture {
    static func main() throws {
        while let line = readLine() {
            let control = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! DriverObject
            var timeMs = 0.0, active = false, polls = 0, posts = [String](), keys = 0, restores = 0, preparations = 0, checks = 0
            var secure = control["secure"] as? Bool == true, held = UInt64(control["held"] as? Int ?? 0)
            var front: Int32 = control["alreadyFront"] as? Bool == true ? 42 : 1
            var window = "original"
            var traces = [DriverObject]()
            var frontmostCalls = 0
            var restoreCalls = 0
            let focus = DriverFocusBelief(providers: DriverFocusProviders(
                secureInput: { secure }, heldModifiers: { held },
                snapshot: { _ in
                    if active { timeMs += control["snapshotDelayMs"] as? Double ?? 0 }
                    if control["snapshotThrowsCleanup"] as? Bool == true && posts.contains("deactivate") { front = 42; throw DriverFault("AX_UNAVAILABLE") }
                    return DriverFocusSnapshot(pid: front, processStart: "start-\(front)", window: window as CFString)
                },
                belief: { _, _ in
                    polls += 1; timeMs += control["beliefDelayMs"] as? Double ?? 0
                    if active {
                        if let at = control["beliefAtMs"] as? Int { return timeMs >= Double(at) }
                        return !(control["timeout"] as? Bool == true) && polls >= 3
                    }
                    if control["windowDuringRestore"] as? Bool == true { window = "changed" }
                    if let delay = control["restoreDelayMs"] as? Double { timeMs += delay }
                    if control["targetAtCleanup"] as? Bool == true { front = 42 }
                    return control["stuck"] as? Bool == true
                },
                makeEvent: { activation in
                    preparations += 1
                    if preparations == control["prepareThrowsAt"] as? Int { throw DriverFault("AX_UNAVAILABLE") }
                    return { _ in
                        posts.append(activation ? "activate" : "deactivate"); active = activation
                        if activation && control["identityLost"] as? Bool == true { timeMs += 7 }
                        if activation, let delay = control["activationDelayMs"] as? Double { timeMs += delay }
                        if activation && control["activationThrows"] as? Bool == true || !activation && control["deactivationThrows"] as? Bool == true {
                            throw DriverFault("AX_UNAVAILABLE")
                        }
                    }
                },
                now: { timeMs / 1000 }, pause: { amount in
                    timeMs += (amount * 1000).rounded()
                    if control["frontDuringBelief"] as? Bool == true { front = 9 }
                    if !active && control["frontDuringRetry"] as? Bool == true { front = 9 }
                },
                restore: { previous, target, _ in
                    restoreCalls += 1; timeMs += control["actualRestoreDelayMs"] as? Double ?? 0
                    guard front == target else { return false }
                    restores += 1; front = previous.pid; window = "original"; return true
                }, frontmost: {
                    frontmostCalls += 1
                    if control["frontmostThrows"] as? Bool == true || frontmostCalls <= (control["frontmostFailures"] as? Int ?? 0) {
                        throw DriverFault("KEY_FOCUS_UNAVAILABLE")
                    }
                    let start = control["processDuringRetry"] as? Bool == true ? "replacement" : "start-\(front)"
                    return DriverFocusSnapshot(pid: front, processStart: start, window: nil)
                },
                personInputSince: { _ in control["personKey"] as? Bool == true && keys > 0 ||
                    control["personDuringRetry"] as? Bool == true && frontmostCalls > 0 }), trace: { traces.append($0) })
            var output: DriverObject
            do {
                let result = try focus.run(pid: 42, check: {
                    checks += 1; timeMs += control["guardDelayMs"] as? Double ?? 0
                    if checks == control["checkThrowsAt"] as? Int { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) }
                }, identity: {
                    if control["identityLost"] as? Bool == true && !posts.isEmpty { throw DriverFault("IDENTITY_CHANGED") }
                }) { guardInput, _ in
                    for index in 0..<3 {
                        if index == 1 {
                            if control["frontChange"] as? Bool == true { front = 9 }
                            if control["targetFront"] as? Bool == true { front = 42 }
                            if control["windowChange"] as? Bool == true { window = "changed" }
                            if control["secureMid"] as? Bool == true { secure = true }
                            if control["heldMid"] as? Bool == true { held = 0x100000 }
                            if control["bodyThrows"] as? Bool == true { throw DriverFault("AX_UNAVAILABLE") }
                            if let delay = control["bodyDelayMs"] as? Double { timeMs += delay }
                            if let at = control["bodyAtMs"] as? Double { timeMs = at }
                        }
                        try guardInput(); keys += 1
                    }
                    if let delay = control["afterLastKeyMs"] as? Double { timeMs += delay }
                    return ["delivery": "sent-unverified"]
                }
                output = ["ok": true, "result": result]
            } catch let error as DriverFocusFault {
                output = ["ok": false, "error": ["code": (error.cause as? DriverFault)?.code ?? "UNKNOWN",
                    "message": (error.cause as? DriverFault)?.message ?? "UNKNOWN",
                    "unhealthy": error.unhealthy, "focusChanged": error.focusChanged, "focusRestored": error.focusRestored,
                    "fakeActiveMs": error.fakeActiveMs]]
            } catch let error as DriverFault { output = ["ok": false, "error": ["code": error.code, "unhealthy": error.unhealthy]] }
            output["posts"] = posts; output["keys"] = keys; output["restores"] = restores; output["elapsedMs"] = timeMs
            output["traces"] = traces
            output["frontmostCalls"] = frontmostCalls
            output["restoreCalls"] = restoreCalls
            print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
        }
    }
}
