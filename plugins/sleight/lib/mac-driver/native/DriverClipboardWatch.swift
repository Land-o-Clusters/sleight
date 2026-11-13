import AppKit

// Only count metadata crosses this boundary. Requests share their first
// admission baseline, and one runtime remembers the last completed action.
final class DriverClipboardWatch {
    final class Admission {
        let baseline: Int
        init(_ baseline: Int) { self.baseline = baseline }
    }
    private let count: () throws -> Int
    private let now: () -> Double
    private let personInputSince: (Double) -> Bool
    private var lastCount: Int?
    private var lastActionEnded: Double = 0
    init(count: @escaping () throws -> Int = DriverClipboardWatch.systemCount,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         personInputSince: @escaping (Double) -> Bool) {
        self.count = count; self.now = now; self.personInputSince = personInputSince
    }
    static func systemCount() throws -> Int {
        // The single reviewed OS boundary returns an integer, never contents.
        return try NSPasteboard.general.changeCount
    }
    private func readCount(admitted: Bool) throws -> Int {
        do { return try count() }
        catch {
            var fault = DriverFault("ACTION_UNSUPPORTED")
            fault.disposition = ["delivery": admitted ? "unknown" : "not-sent",
                "retry": admitted ? "read-first" : "safe", "reason": "clipboard-count-unavailable"]
            if !admitted { fault.disposition["clipboard"] = "untouched" }
            throw fault
        }
    }
    func admit(_ admission: inout Admission?) throws {
        guard admission == nil else { return }
        let current = try readCount(admitted: false)
        if let previous = lastCount, current != previous, !personInputSince(lastActionEnded) {
            // Report each observed change once. Keep the last completed action's
            // time so another late change still refuses before the next input.
            lastCount = current
            var fault = DriverFault("CLIPBOARD_CHANGED")
            fault.disposition = ["delivery": "not-sent", "retry": "read-first", "clipboardChanged": true,
                "reason": "since-last-action"]
            throw fault
        }
        admission = Admission(current)
    }
    func finish(_ admission: Admission?) throws -> Bool {
        guard let admission = admission else { return false }
        let current = try readCount(admitted: true)
        lastCount = current; lastActionEnded = now()
        return current != admission.baseline
    }
    // A compound shares one Admission. It must check between input steps and
    // stop before its next step when this returns true.
    func changed(_ admission: Admission) throws -> Bool {
        try readCount(admitted: true) != admission.baseline
    }
}
