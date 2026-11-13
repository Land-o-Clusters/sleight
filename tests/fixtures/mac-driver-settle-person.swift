// No system providers are executed. The harness reads no desktop state and posts no input.
func check(_ name: String, _ pass: @autoclosure () throws -> Bool) {
    let row: DriverObject = ["name": name, "pass": (try? pass()) ?? false]
    let data = try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
}
func faultCode(_ work: () throws -> Void) -> String {
    do { try work(); return "none" } catch let fault as DriverFault { return fault.code } catch { return "unexpected" }
}
final class SettleFixture {
    var now = 0.0
    var events: [(Double, DriverSettleNotification)] = []
    var changes: [(Double, String?)] = [(0, "initial")]
    var busy: [(Double, Int)] = [(0, 0)]
    var windows: [(Double, String?)] = [(0, nil)]
    var images: [(Double, String)] = [(0, "pixels")]
    var digestTimes: [Double] = [], captureTimes: [Double] = [], windowTimes: [Double] = []
    var stopped = 0, started = 0, complete = true
    var completeAt = Double.infinity
    var personReason = "person-took-over"
    var personFault = false, personDelay = 0.0
    var personProvider: (() throws -> String?)?
    var inputAdmitted = false
    var deadline = Double.infinity, personAt = Double.infinity
    var treeProvider: ((Double) throws -> DriverSettleTree)?
    var treeFault: String?
    var captureFault: String?
    var failTree = false, failCapture = false, failObserve = false
    var delayedTree = 0.0, delayedCapture = 0.0
    var startupEvent = false
    var limited = false
    var baseline: DriverSettleTree?
    var delivered = Set<Int>()
    func latest<T>(_ rows: [(Double, T)]) -> T { rows.last(where: { $0.0 <= now })!.1 }
    func run(_ params: DriverObject = [:]) throws -> DriverObject {
        let options = try DriverSettleOptions(params)
        var receive: ((DriverSettleNotification) -> Void)?
        func deliver() {
            for (index, event) in self.events.enumerated() where event.0 <= self.now && self.delivered.insert(index).inserted { receive?(event.1) }
        }
        return try DriverSettle.run(options, baseline: baseline, inputAdmitted: inputAdmitted, providers: DriverSettleProviders(
            now: { self.now }, wait: { ms in
                self.now += ms; deliver()
            }, check: { if self.now >= self.deadline { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) } },
            person: {
                self.now += self.personDelay
                if let provider = self.personProvider { return try provider() }
                if self.personFault { throw DriverFault("DRIVER_INTERNAL") }
                return self.now >= self.personAt ? self.personReason : nil
            },
            observe: { callback in
                self.started += 1
                if self.failObserve { throw DriverFault("AX_UNAVAILABLE") }
                receive = callback
                if self.startupEvent { self.now += 100; callback(.change) }
                return { self.stopped += 1; receive = nil }
            }, tree: {
                self.digestTimes.append(self.now); self.now += self.delayedTree
                if let provider = self.treeProvider { return try provider(self.now) }
                if let code = self.treeFault { throw DriverFault(code) }
                if self.failTree { throw DriverFault("IDENTITY_CHANGED") }
                return DriverSettleTree(digest: self.latest(self.changes), busyElements: self.latest(self.busy), complete: self.complete || self.now >= self.completeAt, limited: self.limited)
            }, capture: {
                self.captureTimes.append(self.now); self.now += self.delayedCapture
                if let code = self.captureFault { throw DriverFault(code) }
                if self.failCapture { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
                return self.latest(self.images)
            }, primaryWindow: { self.windowTimes.append(self.now); return self.latest(self.windows) }, drain: { deliver() }))
    }
}
func settle(_ name: String, _ setup: (SettleFixture) -> Void = { _ in }, _ params: DriverObject = [:],
            _ want: (DriverObject, SettleFixture) -> Bool) {
    let fixture = SettleFixture(); setup(fixture)
    do { let value = try fixture.run(params); check(name, want(value, fixture)) }
    catch { check(name, false) }
}

settle("no AX changes require two matching captures 100 ms apart", { _ in }, [:]) { v, f in
    v["reason"] as? String == "matching-captures" && v["settled"] as? Bool == true &&
    f.captureTimes == [120, 220] && f.stopped == 1 && v["quietBasis"] as? String == "captures"
}
settle("tree digest polls run every 50 ms without replacing the retained read", { $0.changes = [(0, "a"), (50, "b")] }) { v, f in
    v["reason"] as? String == "quiet" && v["elapsedMs"] as? Double == 170 && f.digestTimes == [0, 50, 100, 150] && f.captureTimes.isEmpty && v["quietBasis"] as? String == "digest"
}
settle("digest work does not add another 50 ms to the poll cadence", { $0.delayedTree = 5; $0.changes = [(0, "a"), (50, "b")] }) { v, f in
    v["reason"] as? String == "quiet" && f.digestTimes == [0, 50, 100, 150]
}
for event in [DriverSettleNotification.change, .scroll] {
    settle("notification resets quiet: \(event)", { $0.events = [(100, event)] }, ["includeScroll": event == .scroll]) { v, f in
        v["reason"] as? String == "quiet" && v["elapsedMs"] as? Double == 220 && f.captureTimes.isEmpty && v["quietBasis"] as? String == "notification"
    }
}
settle("scroll notifications do not reset quiet by default", { $0.events = [(100, .scroll)] }) { v, f in
    v["reason"] as? String == "matching-captures" && f.captureTimes == [120, 220]
}
settle("notification after first capture invalidates its comparison", { $0.events = [(150, .change)] }) { v, f in
    v["reason"] as? String == "quiet" && v["elapsedMs"] as? Double == 270 && f.captureTimes == [120]
}
settle("notification queued during a tree poll resets quiet before returning", { f in
    f.delayedTree = 40; f.changes = [(0, "a"), (50, "b")]; f.events = [(220, .change)]
}) { v, f in
    v["reason"] as? String == "quiet" && f.now >= 360 && f.stopped == 1
}
settle("notification queued during the second capture invalidates matching pixels", { f in
    f.delayedCapture = 20; f.events = [(250, .change)]
}) { v, f in
    v["reason"] as? String == "quiet" && f.now >= 380 && f.captureTimes == [120, 240]
}
settle("budget-limited digest reports notification-none without capture permission or notifications", { f in
    f.complete = false; f.limited = true; f.failCapture = true
}) { v, f in
    v["reason"] as? String == "quiet" && v["digestComplete"] as? Bool == false && f.now == 120 && f.captureTimes == [120] && v["quietBasis"] as? String == "notification-none"
}
settle("budget-limited quiet still restarts for notifications", { f in
    f.complete = false; f.limited = true; f.events = [(100, .change)]
}) { v, f in v["reason"] as? String == "quiet" && f.now == 220 }
settle("budget-limited digest tries captures when no notification arrived", { f in
    f.complete = false; f.limited = true
}) { v, f in
    v["reason"] as? String == "matching-captures" && v["quietBasis"] as? String == "captures" && f.captureTimes == [120, 220]
}
settle("changed partial prefix resets notification quiet without a capture grant", { f in
    f.complete = false; f.limited = true; f.failCapture = true; f.changes = [(0, "a"), (100, "b")]
}) { v, f in
    v["reason"] as? String == "quiet" && v["quietBasis"] as? String == "notification-none" && f.now == 220 && f.captureTimes == [220]
}
settle("budget-limited digest without an observer cannot claim quiet", { f in
    f.complete = false; f.limited = true; f.failObserve = true
}, ["capMs": 250]) { v, f in v["reason"] as? String == "cap" && f.now == 250 }
settle("read-time digest sees action completed before the first poll without captures", { f in
    f.baseline = DriverSettleTree(digest: "before", busyElements: 0, complete: true)
    f.failCapture = true
}) { v, f in v["reason"] as? String == "quiet" && f.now == 120 && f.captureTimes.isEmpty }
settle("unchanged read-time digest still needs visual evidence", { f in
    f.baseline = DriverSettleTree(digest: "initial", busyElements: 0, complete: true)
}) { v, f in v["reason"] as? String == "matching-captures" && f.captureTimes == [120, 220] }
settle("changing AX tree resets every quiet window", { $0.changes = [(0, "a"), (50, "b"), (100, "c"), (200, "d")] }) { v, _ in
    v["reason"] as? String == "quiet" && v["elapsedMs"] as? Double == 320
}
settle("never quiet notifications return the normal cap", { f in f.events = stride(from: 50.0, through: 1500, by: 50).map { ($0, .change) } }) { v, f in
    v["reason"] as? String == "cap" && v["settled"] as? Bool == false && f.now == 1500 && f.stopped == 1
}
settle("busy progress extends normal cap and reports peak count", { $0.busy = [(0, 2)] }) { v, f in
    v["reason"] as? String == "busy-cap" && v["busyElements"] as? Int == 2 && f.now == 5000 && f.captureTimes.isEmpty
}
settle("busy extension can be disabled", { $0.busy = [(0, 1)] }, ["extendForBusy": false]) { v, f in
    v["reason"] as? String == "cap" && v["settled"] as? Bool == false && f.now == 1500
}
settle("busy clears only after a fresh quiet window", { $0.busy = [(0, 3), (1700, 0)] }) { v, f in
    v["reason"] as? String == "quiet" && v["busyElements"] as? Int == 3 && f.now == 1820
}
settle("busy cap cannot shorten normal cap", { $0.busy = [(0, 1)] }, ["busyCapMs": 100]) { v, f in
    v["reason"] as? String == "busy-cap" && f.now == 1500
}
settle("busy appearing after normal quiet prevents early success", { $0.busy = [(0, 0), (100, 1)] }) { v, f in
    v["reason"] as? String == "busy-cap" && f.captureTimes.isEmpty
}
settle("primary window is polled at 50 ms until new primary exists", { $0.windows = [(0, nil), (150, "new-window")]; $0.events = [(150, .change)] }, ["waitForWindow": true]) { v, f in
    v["primaryWindowId"] as? String == "new-window" && v["settled"] as? Bool == true && f.windowTimes == [0, 50, 100, 150] && f.now == 270
}
settle("missing primary window returns cap even with a stable tree", { _ in }, ["waitForWindow": true, "capMs": 200]) { v, f in
    v["reason"] as? String == "cap" && v["settled"] as? Bool == false && f.captureTimes.isEmpty && f.now == 200
}
settle("primary-window polling is opt-in", { _ in }) { _, f in f.windowTimes.isEmpty }
settle("changed capture cannot report settled", { $0.images = [(0, "a"), (200, "b"), (400, "c")] }, ["capMs": 250]) { v, f in
    v["settled"] as? Bool == false && v["reason"] as? String == "cap" && f.now == 250
}
settle("no AX tree can settle only from matching captures", { $0.changes = [(0, nil)] }) { v, f in
    v["reason"] as? String == "matching-captures" && f.captureTimes.count == 2
}
settle("incomplete digest cannot prove quiet", { $0.complete = false }, ["capMs": 250]) { v, f in
    v["settled"] as? Bool == false && f.captureTimes.isEmpty && f.now == 250
}
settle("first complete poll after a partial walk starts fresh quiet", { $0.complete = false; $0.completeAt = 200; $0.changes = [(0, "a"), (50, "b")]; $0.events = [(50, .change)] }) { v, f in
    v["reason"] as? String == "quiet" && f.now == 320
}
settle("changed partial digest cannot establish evidence for a later complete walk", { $0.complete = false; $0.completeAt = 200; $0.changes = [(0, "a"), (50, "b")] }) { v, f in
    v["reason"] as? String == "matching-captures" && v["quietBasis"] as? String == "captures" && f.now == 420 && f.captureTimes == [320, 420]
}
settle("observer unavailable still uses tree digest polling", { $0.failObserve = true; $0.changes = [(0, "a"), (50, "b")] }) { v, f in
    v["reason"] as? String == "quiet" && f.now == 170 && f.stopped == 0
}
settle("notification during observer setup starts a new quiet window", { $0.startupEvent = true }) { v, f in
    v["reason"] as? String == "quiet" && f.now == 220 && f.captureTimes.isEmpty && f.stopped == 1
}
settle("person takeover stops settle and cleans observer", { $0.personAt = 100 }) { v, f in
    v["reason"] as? String == "person-took-over" && v["personTookOver"] as? Bool == true && v["settled"] as? Bool == false && f.now == 100 && f.stopped == 1
}
settle("person arriving during a slow tree poll stops a quiet result", { $0.delayedTree = 100; $0.events = [(140, .change)]; $0.personAt = 200 }, ["quietMs": 50]) { v, f in
    v["reason"] as? String == "person-took-over" && v["settled"] as? Bool == false && f.stopped == 1
}
for (name, setup, code) in [
    ("request deadline", { (f: SettleFixture) in f.deadline = 100 }, "DEADLINE_EXCEEDED"),
    ("deadline during capture", { (f: SettleFixture) in f.deadline = 200; f.delayedCapture = 100 }, "DEADLINE_EXCEEDED"),
    ("AX error before the slice ends", { (f: SettleFixture) in f.treeFault = "AX_UNAVAILABLE"; f.delayedTree = 5 }, "AX_UNAVAILABLE"),
    ("identity lost during tree poll", { (f: SettleFixture) in f.failTree = true }, "IDENTITY_CHANGED"),
    ("capture permission unavailable", { (f: SettleFixture) in f.failCapture = true }, "SCREEN_RECORDING_REQUIRED")
] {
    let f = SettleFixture(); setup(f)
    check("\(name) propagates and cleans observer", faultCode { _ = try f.run() } == code && f.stopped == 1)
}
for (name, params, busy) in [("window wait deadline", ["waitForWindow": true] as DriverObject, 0),
                            ("busy extension deadline", [:] as DriverObject, 1)] {
    let f = SettleFixture(); f.deadline = 100; f.busy = [(0, busy)]
    check(name, faultCode { _ = try f.run(params) } == "DEADLINE_EXCEEDED" && f.stopped == 1 && f.now == 100)
}
settle("slow digest beyond cap cannot report quiet", { $0.delayedTree = 200 }, ["capMs": 100]) { v, _ in
    v["reason"] as? String == "cap" && v["settled"] as? Bool == false
}
for (key, bad) in [("quietMs", -1), ("quietMs", 0), ("capMs", 30001), ("busyCapMs", 0)] {
    check("reject out-of-range \(key)=\(bad)", faultCode { _ = try DriverSettleOptions([key: bad]) } == "INVALID_PARAMS")
}
for key in ["includeScroll", "waitForWindow", "extendForBusy"] {
    check("reject nonboolean \(key)", faultCode { _ = try DriverSettleOptions([key: 1]) } == "INVALID_PARAMS")
}
check("reject fractional quiet duration", faultCode { _ = try DriverSettleOptions(["quietMs": 1.5]) } == "INVALID_PARAMS")
check("reject boolean cap duration", faultCode { _ = try DriverSettleOptions(["capMs": true]) } == "INVALID_PARAMS")

let personWindow: DriverObject = ["windowId": "42", "pid": 321, "processStart": "start"]
func sample(_ at: Double = 10, _ idle: Double = 10, _ front: Int? = 321, _ pointer: Int? = nil) -> DriverPersonSample {
    DriverPersonSample(at: at, hidIdle: idle, frontmostPID: front, pointerPID: pointer)
}
func personCase(_ name: String, _ before: DriverPersonSample, _ after: DriverPersonSample, _ reason: String?) {
    var current = before
    let person = DriverPerson(providers: DriverPersonProviders(sample: { current }))
    do {
        let watch = try person.begin(window: personWindow)
        current = after
        check(name, try watch.check() == reason)
    } catch { check(name, false) }
}
personCase("two ms sample jitter does not invent takeover", sample(), sample(10.202, 10.2), nil)
personCase("five ms HID change still detects takeover", sample(), sample(10.205, 10.2), "person-took-over")
personCase("private-source posts do not change the HID last-event time", sample(), sample(10.2, 10.2), nil)
personCase("new HID input in foreground target is takeover", sample(), sample(10.2, 0), "person-took-over")
personCase("HID input under pointer is takeover with target background", sample(10, 10, 999, 321), sample(10.2, 0, 999, 321), "person-took-over")
personCase("HID input in unrelated foreground app does not claim target takeover", sample(10, 10, 999, nil), sample(10.2, 0, 999, nil), nil)
personCase("HID input remains detected after idle exceeds earlier sample", sample(10, 1), sample(12, 1.5), "person-took-over")
personCase("frontmost change alone does not invent HID input", sample(), sample(10.2, 10.2, 999, nil), nil)
personCase("HID plus frontmost change retains the earlier target relevance", sample(), sample(10.2, 0, 999, nil), "person-took-over")
var current = sample(10, 0.1)
let person = DriverPerson(providers: DriverPersonProviders(sample: { current }))
let activeWatch = try! person.begin(window: personWindow)
check("recent person activity returns person-active without waiting", try! activeWatch.check() == "person-active")
current = sample(20, 20)
check("takeover remains sticky for the whole call", try! activeWatch.check() == "person-active")
let state = try! person.state(window: personWindow)
let token = state["token"] as! String
check("person state produces an opaque token", !token.isEmpty && state["personTookOver"] as? Bool == false)
check("same-incarnation token can guard input", faultCode { _ = try person.begin(window: personWindow, token: token) } == "none")
current = sample(20.2, 0)
let tokenWatch = try! person.begin(window: personWindow, token: token)
check("HID change since token is detected before input", try! tokenWatch.check() == "person-took-over")
check("another incarnation refuses old tokens", faultCode { _ = try DriverPerson(providers: DriverPersonProviders(sample: { current })).begin(window: personWindow, token: token) } == "PERSON_TOOK_OVER")
check("token cannot move to another binding", faultCode { _ = try person.begin(window: ["windowId": "43", "pid": 321, "processStart": "start"], token: token) } == "PERSON_TOOK_OVER")
check("token cannot survive process replacement", faultCode { _ = try person.begin(window: ["windowId": "42", "pid": 321, "processStart": "other"], token: token) } == "PERSON_TOOK_OVER")
let tookOverTokenState = try! person.state(window: personWindow)
check("a token preserves takeover since the preceding state read", tookOverTokenState["reason"] as? String == "person-took-over" &&
    faultCode { _ = try person.begin(window: personWindow, token: tookOverTokenState["token"] as? String) } == "PERSON_TOOK_OVER")
let freshActivePerson = DriverPerson(providers: DriverPersonProviders(sample: { current }))
let activeTokenState = try! freshActivePerson.state(window: personWindow)
let activeTokenWatch = try! freshActivePerson.begin(window: personWindow, token: activeTokenState["token"] as? String)
check("a fresh token cannot bypass person-active refusal", try! activeTokenWatch.check() == "person-active")
for _ in 0..<65 { _ = try! person.state(window: personWindow) }
check("old tokens expire after the bounded 64-token bank fills", faultCode { _ = try person.begin(window: personWindow, token: token) } == "PERSON_TOOK_OVER")
for bad in [sample(10, .nan), sample(10, -1), sample(.infinity, 1), sample(10, 1, nil)] {
    let p = DriverPerson(providers: DriverPersonProviders(sample: { bad }))
    check("unavailable person sample fails closed", faultCode { _ = try p.begin(window: personWindow) } == "DRIVER_INTERNAL")
}
var sampled = 0
let inert = DriverPerson(providers: DriverPersonProviders(sample: { sampled += 1; return sample() }))
check("person construction is inert", sampled == 0)
_ = inert

// Integration uses only the RT2 in-memory inventory and RT24 fake session.
let bounds: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
let window: DriverObject = ["windowId": "42", "pid": 321, "processStart": "start", "bounds": bounds,
                            "onScreen": true, "layer": 0, "hidden": false]
func coreFixture(_ locked: Bool) -> DriverObject {
    ["apps": [], "windows": [window], "session": ["kCGSSessionOnConsoleKey": true,
     "kCGSessionLoginDoneKey": true, "CGSSessionScreenIsLocked": locked],
     "trees": ["42": ["AXRole": "AXWindow", "AXMinimized": false, "AXFullScreen": false,
                       "pid": 321, "frame": bounds, "children": []]]]
}
func request(_ method: String, _ params: DriverObject) throws -> DriverRequest {
    let nonce = String(repeating: "a", count: 64)
    return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": 1,
        "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 5000], nonce: nonce, previous: 0)
}
let action = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0]])
var lockedSamples = 0
let lockedCore = DriverCore(fixture: coreFixture(true), personProviders: DriverPersonProviders(sample: { lockedSamples += 1; return sample() }))
check("locked fixture refuses before person sampling or input", faultCode { try lockedCore.checkPerson(action) } == "SCREEN_LOCKED" && lockedSamples == 0)
var inputSample = sample()
let guardedCore = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: { inputSample }))
check("pre-input guard accepts quiet identity-bound fixture", faultCode { try guardedCore.checkPerson(action) } == "none")
inputSample = sample(10.2, 0)
try action.admitInput()
check("post-input guard detects takeover without a real post", faultCode { try guardedCore.checkPerson(action) } == "PERSON_TOOK_OVER")
do {
    try guardedCore.checkPerson(action); check("post-admission takeover preserves unknown/read-first disposition", false)
} catch let fault as DriverFault {
    check("post-admission takeover preserves unknown/read-first disposition", fault.disposition["delivery"] as? String == "unknown" && fault.disposition["retry"] as? String == "read-first" && fault.disposition["personTookOver"] as? Bool == true)
}
for copyFirst in [true, false] {
    var value = sample()
    var samples = 0
    let core = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: { samples += 1; return value }))
    let original = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0]])
    let copy = DriverRequest(copying: original, method: "settle", params: original.params)
    let first = copyFirst ? copy : original, second = copyFirst ? original : copy
    try! core.checkPerson(first)
    value = sample(10.2, 0)
    check("request copies retain the first baseline regardless of initialization order \(copyFirst)",
        faultCode { try core.checkPerson(second) } == "PERSON_TOOK_OVER")
    value = sample(20, 20)
    let before = samples
    check("request copies share sticky takeover without resampling \(copyFirst)",
        faultCode { try core.checkPerson(first) } == "PERSON_TOOK_OVER" && samples == before)
}
let activeRequest = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0]])
do {
    try guardedCore.checkPerson(activeRequest); check("pre-admission activity returns not-sent/safe disposition", false)
} catch let fault as DriverFault {
    check("pre-admission activity returns not-sent/safe disposition", fault.disposition["delivery"] as? String == "not-sent" && fault.disposition["retry"] as? String == "safe" && fault.disposition["reason"] as? String == "person-active")
}

// Digest never reads values or descendants of secure controls.
let secure = DriverNode(fake: ["AXRole": "AXSecureTextField", "frame": bounds, "forbidReads": ["AXValue", "AXTitle", "AXChildren"],
    "children": [["AXRole": "AXStaticText", "forbidReads": ["AXRole"]]]], path: "secure")
let digestRequest = try! request("settle", [:])
check("secure digest skips sensitive attributes and descendants", faultCode { _ = try DriverSettleTree.read(secure, request: digestRequest, includeScroll: false) } == "none")
let busyRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [
    ["AXRole": "AXProgressIndicator", "frame": bounds],
    ["AXRole": "AXButton", "AXElementBusy": true, "frame": bounds],
    ["AXRole": "AXProgressIndicator", "AXHidden": true, "frame": bounds]]], path: "busy")
let busyTree = try! DriverSettleTree.read(busyRoot, request: digestRequest, includeScroll: false)
check("digest counts visible progress and busy elements once", busyTree.busyElements == 2 && busyTree.complete)
let framelessRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [
    ["AXRole": "AXGroup", "children": [["AXRole": "AXButton", "AXTitle": "child", "frame": bounds]]],
    ["AXRole": "AXProgressIndicator"]]], path: "frameless")
let framelessTree = try! DriverSettleTree.read(framelessRoot, request: digestRequest, includeScroll: false)
check("unavailable geometry leaves the digest incomplete without counting invisible busy state",
    !framelessTree.complete && framelessTree.faulted && !framelessTree.axChanged && framelessTree.busyElements == 0)
let changedFramelessRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [
    ["AXRole": "AXGroup", "children": [["AXRole": "AXButton", "AXTitle": "changed child", "frame": bounds]]],
    ["AXRole": "AXProgressIndicator"]]], path: "frameless")
check("digest still visits children of a frameless node",
    try DriverSettleTree.read(changedFramelessRoot, request: digestRequest, includeScroll: false).digest != framelessTree.digest)
do {
    let f = SettleFixture()
    f.treeProvider = { _ in framelessTree }
    let result = try! f.run(["capMs": 200])
    check("persistently frameless fixture reaches cap with a clean observer",
        result["reason"] as? String == "cap" && result["settled"] as? Bool == false &&
        result["observer"] as? Bool == true && f.captureTimes.isEmpty && f.now == 200)
}

func frameTree(_ fault: String? = nil, delay: Int = 0) throws -> DriverSettleTree {
    var child: DriverObject = ["AXRole": "AXButton", "AXTitle": "unchanged", "frame": bounds]
    // Production drops AXValue(.axError) attributes. Missing position/size then
    // reaches frame()'s STALE_ELEMENT guard, just as this in-memory node does.
    if fault == "attribute-error" { child.removeValue(forKey: "frame") }
    else if let fault = fault { child["frameFault"] = fault }
    if delay > 0 { child["frameDelayMs"] = delay }
    return try DriverSettleTree.read(DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds,
        "children": [child]], path: "frame-fault"), request: digestRequest, includeScroll: false)
}
let normalFrameTree = try! frameTree()
let unavailableFrameTree = try! frameTree("AX_UNAVAILABLE")
check("frame transport failure marks the digest faulted without change evidence",
    !unavailableFrameTree.complete && unavailableFrameTree.faulted && !unavailableFrameTree.axChanged && !unavailableFrameTree.limited)
let timedOutFrameTree = try! frameTree(delay: 50)
check("frame messaging slice timeout remains a fault rather than a time limit",
    !timedOutFrameTree.complete && timedOutFrameTree.faulted && !timedOutFrameTree.limited && !timedOutFrameTree.axChanged)
let staleFrameTree = try! frameTree("STALE_ELEMENT")
check("stale frame leaves an incomplete faulted digest without change evidence",
    !staleFrameTree.complete && staleFrameTree.faulted && !staleFrameTree.axChanged && !staleFrameTree.limited)
for code in ["DRIVER_INTERNAL", "DEADLINE_EXCEEDED"] {
    check("frame read propagates \(code)", faultCode { _ = try frameTree(code) } == code)
}
for frameFault in ["AX_UNAVAILABLE", "STALE_ELEMENT", "attribute-error"] {
for captureDenied in [false, true] {
    let f = SettleFixture()
    f.baseline = normalFrameTree; f.failCapture = captureDenied
    var faultedPolls = 0
    f.treeProvider = { now in
        let tree = try frameTree(now == 50 ? frameFault : nil)
        if tree.faulted { faultedPolls += 1 }
        return tree
    }
    if captureDenied {
        check("one failed frame poll \(frameFault) cannot claim digest quiet without capture permission",
            faultCode { _ = try f.run() } == "SCREEN_RECORDING_REQUIRED" && faultedPolls == 1 && f.captureTimes == [220])
    } else {
        do {
            let value = try f.run()
            check("one failed frame poll \(frameFault) requires capture evidence after recovery",
                value["reason"] as? String == "matching-captures" && value["quietBasis"] as? String == "captures" &&
                faultedPolls == 1 && f.captureTimes == [220, 320])
        } catch { check("one failed frame poll \(frameFault) requires capture evidence after recovery", false) }
    }
}
}

// Cut the same two-level tree after the root, then walk it warm without any action.
// Only fake child enumeration is delayed. Production hashing is unchanged.
let coldTreeRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "digestChildrenDelayMs": 50,
    "children": [["AXRole": "AXButton", "AXTitle": "unchanged", "frame": bounds]]], path: "cold-warm")
let warmTreeRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds,
    "children": [["AXRole": "AXButton", "AXTitle": "unchanged", "frame": bounds]]], path: "cold-warm")
let coldTree = try! DriverSettleTree.read(coldTreeRoot, request: digestRequest, includeScroll: false)
let warmTree = try! DriverSettleTree.read(warmTreeRoot, request: digestRequest, includeScroll: false)
check("cold walk retains a real root prefix and warm walk completes the same tree",
    !coldTree.complete && coldTree.limited && !coldTree.faulted && coldTree.digest != nil && warmTree.complete && coldTree.digest != warmTree.digest)
settle("cold read then warm no-op poll requires capture evidence", { f in
    f.baseline = coldTree; f.treeProvider = { _ in warmTree }
}) { v, f in
    v["reason"] as? String == "matching-captures" && v["quietBasis"] as? String == "captures" && f.captureTimes == [120, 220]
}
settle("cold poll then warm no-op poll requires a fresh capture pair", { f in
    f.treeProvider = { now in now < 50 ? coldTree : warmTree }
}) { v, f in
    v["reason"] as? String == "matching-captures" && v["quietBasis"] as? String == "captures" && f.captureTimes == [170, 270]
}
let deniedColdWarm = SettleFixture()
deniedColdWarm.baseline = coldTree; deniedColdWarm.treeProvider = { _ in warmTree }; deniedColdWarm.failCapture = true
check("cold then warm no-op without capture permission cannot claim digest quiet",
    faultCode { _ = try deniedColdWarm.run() } == "SCREEN_RECORDING_REQUIRED" && deniedColdWarm.captureTimes == [120])
func scrollTree(_ value: Int, _ include: Bool) -> String? {
    try! DriverSettleTree.read(DriverNode(fake: ["AXRole": "AXScrollBar", "AXValue": value, "frame": bounds], path: "scroll"), request: digestRequest, includeScroll: include).digest
}
check("scroll-only digest changes are ignored by default", scrollTree(0, false) == scrollTree(1, false))
check("scroll-only digest changes count when requested", scrollTree(0, true) != scrollTree(1, true))

// Real bounded walks, all against in-memory nodes.
let slowRoot = DriverNode(fake: ["AXRole": "AXWindow", "delayMs": 25, "frame": bounds], path: "slow")
let beforeWalkDeadline = digestRequest.walkDeadline
let slowTree = try! DriverSettleTree.read(slowRoot, request: digestRequest, includeScroll: false)
check("40 ms walk budget marks an incomplete digest for notification fallback", !slowTree.complete && slowTree.limited)
check("bounded digest restores the request walk deadline", digestRequest.walkDeadline == beforeWalkDeadline)
let deadlineNonce = String(repeating: "a", count: 64)
let deadlineWalk = try! DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": deadlineNonce,
    "id": 1, "method": "settle", "params": [:] as DriverObject,
    "deadline": Int(Date().timeIntervalSince1970 * 1000) + 20], nonce: deadlineNonce, previous: 0)
check("request deadline during a slow digest remains a fault", faultCode {
    _ = try DriverSettleTree.read(slowRoot, request: deadlineWalk, includeScroll: false)
} == "DEADLINE_EXCEEDED" && deadlineWalk.walkDeadline == nil)
for children in [2998, 2999, 3000] {
    let root = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds,
        "children": (0..<children).map { _ in ["AXRole": "AXSecureTextField"] as DriverObject }], path: "large")
    let tree = try! DriverSettleTree.read(root, request: digestRequest, includeScroll: false)
    check("node boundary \(children + 1) counts root and never treats a truncated prefix as complete",
        children < 3000 ? tree.complete : !tree.complete && tree.limited)
}
let sharedNode = DriverNode(fake: ["key": "same"], path: "same")
var visitedNodes = Set<DriverSettleNodeKey>()
check("visited set accepts the first node", visitedNodes.insert(DriverSettleNodeKey(node: sharedNode)).inserted)
check("visited set rejects the same proxy in a cycle", !visitedNodes.insert(DriverSettleNodeKey(node: DriverNode(fake: ["key": "same"], path: "same"))).inserted)
check("visited set keeps distinct nodes", visitedNodes.insert(DriverSettleNodeKey(node: DriverNode(fake: ["key": "other"], path: "same"))).inserted)
let expiredDigest = try! request("settle", [:])
expiredDigest.walkDeadline = ProcessInfo.processInfo.systemUptime - 1
let expiredTree = try! DriverSettleTree.read(busyRoot, request: expiredDigest, includeScroll: false)
check("digest respects an earlier caller walk deadline", !expiredTree.complete && expiredTree.limited && expiredTree.digest == nil)
var secondary = window; secondary["windowId"] = "43"
var replacement = secondary; replacement["processStart"] = "replacement"
let mainAttrs: DriverObject = ["AXRole": "AXWindow", "AXSubrole": "AXStandardWindow", "AXMain": true]
check("existing secondary window cannot satisfy new primary wait", try DriverSettle.primaryWindow([secondary], previous: ["42", "43"], bound: window, inspect: { _ in mainAttrs }) == nil)
check("new primary from the bound process is accepted", try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in mainAttrs }) == "43")
check("replacement process cannot satisfy primary wait", try DriverSettle.primaryWindow([replacement], previous: ["42"], bound: window, inspect: { _ in mainAttrs }) == nil)
check("new dialog cannot satisfy primary wait", try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in ["AXRole": "AXWindow", "AXSubrole": "AXDialog", "AXMain": true] }) == nil)
check("new nonprimary window cannot satisfy primary wait", try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in ["AXRole": "AXWindow", "AXMain": false] }) == nil)
var otherPrimary = secondary; otherPrimary["windowId"] = "44"
check("ambiguous new primaries do not pick the first window", try DriverSettle.primaryWindow([secondary, otherPrimary], previous: ["42"], bound: window, inspect: { _ in mainAttrs }) == nil)
check("new CG window waits for AX readiness", try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in throw DriverFault("AX_UNAVAILABLE") }) == nil)
check("uncorroborated primary window is polled again", try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in throw DriverFault("IDENTITY_UNVERIFIED") }) == nil)
check("primary wait propagates process identity changes", faultCode { _ = try DriverSettle.primaryWindow([secondary], previous: ["42"], bound: window, inspect: { _ in throw DriverFault("IDENTITY_CHANGED") }) } == "IDENTITY_CHANGED")
let treeCore = DriverCore(fixture: coreFixture(false))
_ = try! treeCore.readTree(["windowId": "42", "processStart": "start"], request: digestRequest)
check("retained read records before-action window IDs", treeCore.maps["42"]?.windowIDs == ["42"])
check("retained read has a complete before-action digest", treeCore.maps["42"]?.settleTree?.complete == true && treeCore.maps["42"]?.settleTree?.digest != nil)

for code in ["STALE_ELEMENT", "AX_UNAVAILABLE", "DRIVER_INTERNAL"] {
    var fixture = coreFixture(false)
    fixture["trees"] = ["42": ["AXRole": "AXWindow", "pid": 321, "frame": bounds, "children": [
        ["AXRole": "AXButton", "AXTitle": "prefix", "frame": bounds],
        ["AXRole": "AXButton", "frame": bounds, "digestFault": code]]]]
    let core = DriverCore(fixture: fixture)
    let req = try! request("getAXState", ["windowId": "42", "processStart": "start"])
    check("readTree survives a mid-digest \(code) and discards its baseline",
        faultCode { _ = try core.readTree(req.params, request: req) } == "none" && core.maps["42"]?.settleTree == nil)
    if code == "STALE_ELEMENT" || code == "AX_UNAVAILABLE" {
        let root = DriverNode(fake: (fixture["trees"] as! DriverObject)["42"] as! DriverObject, path: "42")
        do {
            let tree = try DriverSettleTree.read(root, request: req, includeScroll: false)
            check("mid-walk \(code) keeps an incomplete prefix without claiming a limit", !tree.complete && !tree.limited && tree.digest != nil)
        } catch { check("mid-walk \(code) keeps an incomplete prefix without claiming a limit", false) }
    }
}

let staleSettle = SettleFixture()
staleSettle.failCapture = true
staleSettle.treeProvider = { now in
    let child: DriverObject = now < 100 ? ["AXRole": "AXButton", "frame": bounds, "digestFault": "STALE_ELEMENT"] :
        ["AXRole": "AXButton", "frame": bounds]
    let root = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [child]], path: "dynamic")
    return try DriverSettleTree.read(root, request: digestRequest, includeScroll: false)
}
do {
    let value = try staleSettle.run()
    check("settle survives a vanished element and waits for a fresh complete walk",
        value["reason"] as? String == "quiet" && value["quietBasis"] as? String == "digest" && staleSettle.now == 220)
} catch { check("settle survives a vanished element and waits for a fresh complete walk", false) }
for code in ["STALE_ELEMENT", "AX_UNAVAILABLE"] {
    let f = SettleFixture()
    f.treeProvider = { _ in
        let root = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [
            ["AXRole": "AXButton", "frame": bounds, "digestFault": code]]], path: "fault")
        return try DriverSettleTree.read(root, request: digestRequest, includeScroll: false)
    }
    do {
        let value = try f.run(["capMs": 250])
        check("repeated mid-walk \(code) cannot claim notification quiet", value["settled"] as? Bool == false && value["reason"] as? String == "cap" && f.captureTimes.isEmpty)
    } catch { check("repeated mid-walk \(code) cannot claim notification quiet", false) }
}

settle("person-active detail is retained in settle", { f in f.personAt = 0; f.personReason = "person-active" }) { v, f in
    v["reason"] as? String == "person-active" && v["personTookOver"] as? Bool == true && v["settled"] as? Bool == false && f.now == 0
}
let personError = SettleFixture(); personError.personFault = true
check("settle propagates a sampler error and cleans observer", faultCode { _ = try personError.run() } == "DRIVER_INTERNAL" && personError.stopped == 1)

// Test the main-queue adapter with fake reads only. No NSWorkspace, HID or CG calls.
var mainReads = 0, enqueues = 0
check("main-thread PID sample reads directly without dispatch", try DriverPersonProviders.frontmostPID(isMainThread: true,
    enqueue: { _ in enqueues += 1 }, read: { mainReads += 1; return 321 }) == 321 && mainReads == 1 && enqueues == 0)
var foreground = 999
let enqueue: (@escaping () -> Void) -> Void = { block in enqueues += 1; block() }
let firstPID = try! DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: enqueue, read: { foreground })
foreground = 321
let secondPID = try! DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: enqueue, read: { foreground })
check("off-main PID samples dispatch a fresh read for each call", firstPID == 999 && secondPID == 321 && enqueues == 2)
for pid in [nil, 0, -1] as [Int?] {
    check("unavailable frontmost PID fails closed \(String(describing: pid))", faultCode {
        _ = try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: enqueue, read: { pid })
    } == "DRIVER_INTERNAL")
}
var queuedRead: (() -> Void)?, lateReads = 0
let beforeTimeout = ProcessInfo.processInfo.systemUptime
do {
    _ = try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: { queuedRead = $0 }, read: { lateReads += 1; return 321 })
    check("unserviced main queue refuses person-unknown without making the helper unhealthy", false)
} catch let fault as DriverFault {
    check("unserviced main queue refuses person-unknown without making the helper unhealthy",
        !fault.unhealthy && fault.disposition["reason"] as? String == "person-unknown" &&
        fault.disposition["personTookOver"] as? Bool == false && ProcessInfo.processInfo.systemUptime - beforeTimeout < 0.5)
}
queuedRead?()
check("timed-out queued sample is discarded before reading", lateReads == 0)
for admitted in [false, true] {
    for timeoutCheck in [1, 2, 12] {
        let f = SettleFixture(); f.inputAdmitted = admitted
        var checks = 0
        let watch = DriverPersonWatch(sample: sample(), pid: 321, providers: DriverPersonProviders(sample: {
            checks += 1
            let pid = try DriverPersonProviders.frontmostPID(isMainThread: false,
                enqueue: { if checks != timeoutCheck { $0() } }, read: { 321 })
            return sample(10, 10, pid)
        }), fresh: false)
        f.personProvider = { try watch.check() }
        do {
            _ = try f.run()
            check("settle watch timeout check=\(timeoutCheck) admitted=\(admitted) preserves disposition and cleanup", false)
        } catch let fault as DriverFault {
            check("settle watch timeout check=\(timeoutCheck) admitted=\(admitted) preserves disposition and cleanup",
                fault.code == "PERSON_TOOK_OVER" && !fault.unhealthy &&
                fault.disposition["reason"] as? String == "person-unknown" && fault.disposition["personTookOver"] as? Bool == false &&
                fault.disposition["delivery"] as? String == (admitted ? "unknown" : "not-sent") &&
                fault.disposition["retry"] as? String == (admitted ? "read-first" : "safe") &&
                fault.message.contains("No input was sent") == !admitted && f.started == 1 && f.stopped == 1 && checks == timeoutCheck)
        }
        check("settle watch remains usable after timeout check=\(timeoutCheck) admitted=\(admitted)", try watch.check() == nil)
    }
    // The real registrar must forward the shared request's admission state.
    for timeoutSample in [1, 2] {
        var samples = 0
        let core = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: {
            samples += 1
            let pid = try DriverPersonProviders.frontmostPID(isMainThread: false,
                enqueue: { if samples != timeoutSample { $0() } }, read: { 321 })
            return sample(10, 10, pid)
        }))
        let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
        runtime.registerSettleAndPerson()
        let req = try! request("settle", ["windowId": "42", "processStart": "start"])
        if admitted { try req.admitInput() }
        do {
            _ = try runtime.fixtureInvoke(req)
            check("settle registrar timeout sample=\(timeoutSample) admitted=\(admitted) preserves admission state", false)
        } catch let fault as DriverFault {
            check("settle registrar timeout sample=\(timeoutSample) admitted=\(admitted) preserves admission state",
                fault.disposition["reason"] as? String == "person-unknown" &&
                fault.disposition["delivery"] as? String == (admitted ? "unknown" : "not-sent") &&
                fault.disposition["retry"] as? String == (admitted ? "read-first" : "safe") &&
                fault.message.contains("No input was sent") == !admitted && !fault.unhealthy && samples == timeoutSample)
        }
    }
}
final class AdmittedPointerSink: DriverPointerSink, DriverPointerPrepared {
    let request: DriverRequest
    var posts = 0, admittedBeforeEveryPost = true
    init(_ request: DriverRequest) { self.request = request }
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws {
        admittedBeforeEveryPost = admittedBeforeEveryPost && request.inputAdmitted
        posts += 1
    }
    func release(_ index: Int) throws {}
}
// Use the production context, pointer dispatch and action wrapper with a recording sink.
for timeoutSample in [1, 2] {
    var samples = 0
    let core = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: {
        samples += 1
        let pid = try DriverPersonProviders.frontmostPID(isMainThread: false,
            enqueue: { if samples != timeoutSample { $0() } }, read: { 321 })
        return sample(10, 10, pid)
    }))
    let binding: DriverObject = ["windowId": "42", "processStart": "start"]
    _ = try! core.readTree(binding, request: request("getAXState", binding))
    let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
    runtime.registerSettleAndPerson()
    let original = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1,
        "args": [0], "read": "full"])
    let earlyCopy = DriverRequest(copying: original, method: "settle", params: binding)
    let sink = AdmittedPointerSink(original)
    runtime.registerAction(method: "click", handler: { action, core in
        let context = try DriverPointer.context(request: action, core: core, geometry: nil, checkPerson: {})
        return try DriverPointer.perform(method: action.method, args: action.params["args"] as! [Any], context: context, sink: sink)
    })
    do {
        _ = try runtime.fixtureInvoke(original)
        check("pointer click then settle timeout sample=\(timeoutSample) cannot authorize retry", false)
    } catch let fault as DriverFault {
        check("pointer click then settle timeout sample=\(timeoutSample) cannot authorize retry",
            sink.posts == 2 && sink.admittedBeforeEveryPost && original.inputAdmitted && earlyCopy.inputAdmitted &&
            fault.json["reason"] as? String == "person-unknown" && fault.json["personTookOver"] as? Bool == false &&
            fault.json["delivery"] as? String == "unknown" && fault.json["retry"] as? String == "read-first" &&
            !fault.message.contains("No input was sent") && !fault.unhealthy && samples == timeoutSample)
    }
}
// The real action wrapper admits on the original, then creates the settle copy.
for timeoutSample in [1, 2] {
    var samples = 0
    let core = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: {
        samples += 1
        let pid = try DriverPersonProviders.frontmostPID(isMainThread: false,
            enqueue: { if samples != timeoutSample { $0() } }, read: { 321 })
        return sample(10, 10, pid)
    }))
    let read = try! request("getAXState", ["windowId": "42", "processStart": "start"])
    _ = try! core.readTree(read.params, request: read)
    let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
    runtime.registerSettleAndPerson()
    var handled: DriverRequest?
    runtime.registerAction(method: "typeText", handler: { original, _ in
        handled = original; try original.admitInput()
        return ["delivery": "sent-unverified", "retry": "read-first"]
    })
    let original = try! request("typeText", ["windowId": "42", "processStart": "start", "readId": 1,
        "args": ["fixture"], "read": "full"])
    let earlyCopy = DriverRequest(copying: original, method: "settle", params: read.params)
    do {
        _ = try runtime.fixtureInvoke(original)
        check("action wrapper settle copy preserves admitted input on timeout sample=\(timeoutSample)", false)
    } catch let fault as DriverFault {
        check("action wrapper settle copy preserves admitted input on timeout sample=\(timeoutSample)",
            handled === original && original.inputAdmitted && earlyCopy.inputAdmitted &&
            fault.json["reason"] as? String == "person-unknown" && fault.json["personTookOver"] as? Bool == false &&
            fault.json["delivery"] as? String == "unknown" && fault.json["retry"] as? String == "read-first" &&
            !fault.message.contains("No input was sent") && !fault.unhealthy && samples == timeoutSample)
    }
}
do {
    let _: Int = try DriverPointer.fromCore {
        try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: { _ in }, read: { 321 })
    }
    check("pointer core mapping preserves person-unknown as no takeover", false)
} catch let fault as DriverPointerFault {
    check("pointer core mapping preserves person-unknown as no takeover",
        fault.code == "PERSON_TOOK_OVER" && fault.personTookOver == false && !fault.unhealthy && fault.message.contains("unknown") &&
        fault.json["reason"] as? String == "person-unknown")
}
for explicit in [nil, false, true] as [Bool?] {
    do {
        let _: Int = try DriverPointer.fromCore {
            var fault = DriverFault("PERSON_TOOK_OVER")
            if let explicit = explicit { fault.disposition["personTookOver"] = explicit }
            throw fault
        }
        check("pointer core mapping honors explicit person flag \(String(describing: explicit))", false)
    } catch let fault as DriverPointerFault {
        check("pointer core mapping honors explicit person flag \(String(describing: explicit))", fault.personTookOver == (explicit ?? true))
    }
}
var timeoutNext = false
let timeoutCore = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: {
    let pid = try DriverPersonProviders.frontmostPID(isMainThread: false,
        enqueue: { if !timeoutNext { $0() } }, read: { 321 })
    return sample(10, 10, pid)
}))
let timeoutToken = try! timeoutCore.person.state(window: window)["token"] as! String
for admitted in [false, true] {
    let req = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0], "personToken": timeoutToken])
    if admitted { try req.admitInput() }
    timeoutNext = true
    do {
        try timeoutCore.checkPersonBeforeInput(req)
        check("frontmost timeout preserves input disposition admitted=\(admitted)", false)
    } catch let fault as DriverFault {
        check("frontmost timeout preserves input disposition admitted=\(admitted)", !fault.unhealthy &&
            fault.disposition["reason"] as? String == "person-unknown" &&
            fault.disposition["delivery"] as? String == (admitted ? "unknown" : "not-sent") &&
            fault.disposition["retry"] as? String == (admitted ? "read-first" : "safe"))
    }
    timeoutNext = false
    check("person token and watch remain usable after frontmost timeout admitted=\(admitted)",
        faultCode { try timeoutCore.checkPersonBeforeInput(req) } == "none")
}

var sharedSample = sample(), sharedSamples = 0
let sharedCore = DriverCore(fixture: coreFixture(false), personProviders: DriverPersonProviders(sample: { sharedSamples += 1; return sharedSample }))
let sharedRuntime = DriverRuntime(core: sharedCore, nonce: String(repeating: "a", count: 64))
sharedRuntime.registerSettleAndPerson()
let settleRequest = try! request("settle", ["windowId": "42", "processStart": "start", "capMs": 1])
let beforeSettleCopy = DriverRequest(copying: settleRequest, method: "click", params: action.params)
_ = try! sharedRuntime.fixtureInvoke(settleRequest)
check("settle stores its watch in the shared request holder", settleRequest.personWatch != nil && settleRequest.personWatch === beforeSettleCopy.personWatch)
sharedSample = sample(10.2, 0)
check("guard after settle uses settle's earlier baseline", faultCode { try sharedCore.checkPerson(beforeSettleCopy) } == "PERSON_TOOK_OVER")
let beforeMissingToken = sharedSamples
var missingTokenMessage = "", missingTokenCode = ""
do { try sharedCore.checkPersonBeforeInput(beforeSettleCopy) } catch let fault as DriverFault { missingTokenMessage = fault.message; missingTokenCode = fault.code }
check("input preflight requires personToken even with an existing watch", missingTokenCode == "INVALID_PARAMS" && missingTokenMessage.contains("personToken") && sharedSamples == beforeMissingToken)
for badToken in ["", 7, false] as [Any] {
    let bad = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0], "personToken": badToken])
    check("input preflight refuses malformed personToken \(String(describing: badToken))", faultCode { try sharedCore.checkPersonBeforeInput(bad) } == "INVALID_PARAMS")
}
sharedSample = sample()
let inputToken = try! sharedCore.person.state(window: window)["token"] as! String
let tokenRequest = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0], "personToken": inputToken])
let tokenSettle = DriverRequest(copying: tokenRequest, method: "settle", params: settleRequest.params)
sharedSample = sample(12, 1.5)
let tokenResult = try! sharedRuntime.fixtureInvoke(tokenSettle)
check("settle-first copy uses the original input token baseline", tokenResult["reason"] as? String == "person-took-over" && tokenRequest.personWatch === tokenSettle.personWatch)
check("input preflight shares settle-first sticky takeover", faultCode { try sharedCore.checkPersonBeforeInput(tokenRequest) } == "PERSON_TOOK_OVER")
sharedSample = sample()
let quietToken = try! sharedCore.person.state(window: window)["token"] as! String
let quietInput = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0], "personToken": quietToken])
check("input preflight accepts a quiet token-bound request without admitting input", faultCode { try sharedCore.checkPersonBeforeInput(quietInput) } == "none" && !quietInput.inputAdmitted)

for delay in [5, 50] {
    let faultRoot = DriverNode(fake: ["AXRole": "AXWindow", "frame": bounds, "children": [
        ["AXRole": "AXButton", "frame": bounds, "delayMs": delay, "digestFault": "AX_UNAVAILABLE"]]], path: "unavailable")
    let f = SettleFixture()
    f.treeProvider = { _ in try DriverSettleTree.read(faultRoot, request: digestRequest, includeScroll: false) }
    do {
        let value = try f.run(["capMs": 150])
        check("AX failure after \(delay) ms never becomes a budget limit",
            value["reason"] as? String == "cap" && value["settled"] as? Bool == false && f.captureTimes.isEmpty)
    } catch { check("AX failure after \(delay) ms never becomes a budget limit", false) }
}
for code in ["CAPTURE_UNAVAILABLE", "IDENTITY_CHANGED", "DRIVER_INTERNAL"] {
    let f = SettleFixture(); f.complete = false; f.limited = true; f.captureFault = code
    check("notification fallback propagates capture fault \(code)", faultCode { _ = try f.run() } == code && f.stopped == 1)
}
settle("notification during denied capture resets quiet before observer fallback", { f in
    f.complete = false; f.limited = true; f.failCapture = true; f.delayedCapture = 20; f.events = [(130, .change)]
}) { v, f in
    v["reason"] as? String == "quiet" && v["quietBasis"] as? String == "notification" && f.now == 260 && f.captureTimes == [120]
}
let deniedDeadline = SettleFixture()
deniedDeadline.complete = false; deniedDeadline.limited = true; deniedDeadline.failCapture = true
deniedDeadline.delayedCapture = 100; deniedDeadline.deadline = 200
check("denied capture fallback still propagates request deadline", faultCode { _ = try deniedDeadline.run() } == "DEADLINE_EXCEEDED" && deniedDeadline.stopped == 1)
settle("caps carry no quiet basis", { _ in }, ["capMs": 100]) { v, _ in v["reason"] as? String == "cap" && v["quietBasis"] == nil }

settle("quiet clock includes time spent sampling the person after a poll", { f in
    f.personDelay = 5; f.changes = [(0, "a"), (50, "b")]
}) { v, f in
    v["reason"] as? String == "quiet" && v["quietBasis"] as? String == "digest" && f.now == 195
}
let latePersonDeadline = SettleFixture(); latePersonDeadline.personDelay = 200; latePersonDeadline.deadline = 100
check("deadline spent in person sampling propagates before a settle result", faultCode { _ = try latePersonDeadline.run() } == "DEADLINE_EXCEEDED" && latePersonDeadline.stopped == 1)

let tokenlessInput = try! request("click", ["windowId": "42", "processStart": "start", "readId": 1, "args": [0]])
let samplesBeforeTokenlessInput = sharedSamples
check("tokenless input fails before constructing a watch or sampling", faultCode {
    try sharedCore.checkPersonBeforeInput(tokenlessInput)
} == "INVALID_PARAMS" && tokenlessInput.personWatch == nil && sharedSamples == samplesBeforeTokenlessInput)
