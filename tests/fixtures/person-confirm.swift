// Drives consent-host.swift's PERSON CONFIRM section with stand-in evaluators, so no Touch ID or password sheet is ever shown.
// Prints one JSON object: the answers each path gave, the reasons the table builds, and the menu rows' arguments.
var answers: [String: [Int32]] = [:]
var cancels: [String: Int] = [:]
let queue = DispatchQueue(label: "person-confirm-fixture")
func stand(_ name: String, available: Bool = true, answer: PersonConfirmResult? = nil, after: Double = 0) -> PersonEvaluator {
    PersonEvaluator(available: { available }, evaluate: { _, done in
        guard let answer = answer else { return }
        queue.asyncAfter(deadline: .now() + after) { done(answer) }
    }, cancel: { queue.async { cancels[name, default: 0] += 1 } })
}
let group = DispatchGroup()
func ask(_ name: String, _ evaluator: PersonEvaluator, timeout: Double = 5) -> () -> Void {
    group.enter()
    var first = true
    return confirmPerson("change sleight's settings", evaluator: evaluator, timeout: timeout, queue: queue) { result in
        answers[name, default: []].append(result.rawValue)
        if first { first = false; group.leave() }
    }
}
_ = ask("confirmed", stand("confirmed", answer: .confirmed))
_ = ask("failed", stand("failed", answer: .failed))
_ = ask("cancelled", stand("cancelled", answer: .cancelled))
_ = ask("unavailable", stand("unavailable", available: false, answer: .confirmed))
_ = ask("timeout", stand("timeout"), timeout: 0.2)
// A late pass after the timeout is ignored: only one answer per ask.
_ = ask("late", stand("late", answer: .confirmed, after: 0.5), timeout: 0.2)
let cancel = ask("cancel", stand("cancel"))
queue.asyncAfter(deadline: .now() + 0.1) { cancel() }
group.wait()
Thread.sleep(forTimeInterval: 0.6)
let reasons: [String: String] = [
    "turbo-on": personConfirmReason(["turbo-on"]) ?? "nil",
    "turbo-on Google Chrome": personConfirmReason(["turbo-on", "Google Chrome"]) ?? "nil",
    "turbo-app-on bundle": personConfirmReason(["turbo-app-on", "com.example.App"]) ?? "nil",
    "unblock free text": personConfirmReason(["permissions-unblock", "com.example.App to stay safe"]) ?? "nil",
    "unknown key": personConfirmReason(["approve-everything"]) ?? "nil",
    "subject on a plain key": personConfirmReason(["permissions-revoke-all", "com.example.App"]) ?? "nil",
    "browser name elsewhere": personConfirmReason(["turbo-app-on", "Google Chrome"]) ?? "nil",
    "too many": personConfirmReason(["turbo-on", "Helium", "x"]) ?? "nil",
]
let menu: [String: [String]] = [
    "revoke-all": menuConfirmArguments(["permissions": "revoke-all"]) ?? ["nil"],
    "revoke electron": menuConfirmArguments(["permissions": "revoke", "target": "electron:com.example.App"]) ?? ["nil"],
    "revoke app name": menuConfirmArguments(["permissions": "revoke", "target": "app:Text Edit"]) ?? ["nil"],
    "block": menuConfirmArguments(["permissions": "block", "target": "com.example.App"]) ?? ["nil"],
]
queue.sync {
    let data = try! JSONSerialization.data(withJSONObject: ["answers": answers, "cancels": cancels, "reasons": reasons, "menu": menu], options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
