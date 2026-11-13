// Every clock, session, inventory and event transport is in memory.
func report(_ name: String, _ pass: Bool) {
    if CommandLine.arguments.contains("--control-server") { return }
    let row: DriverObject = ["name": name, "pass": pass]
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: row))
    FileHandle.standardOutput.write(Data([10]))
}
func code(_ work: () throws -> Void) -> String {
    do { try work(); return "none" } catch let f as DriverFault { return f.code } catch let f as DriverKeyboardFault { return f.code } catch { return "unexpected" }
}
final class PersonWaitFixture {
    var now = 0.0, lastKey = 0.0, burstEnds = 2.0
    var pointer = false, unrelated = false, leavesTarget = false
    var pauses: [Double] = [], samples: [Double] = [], checks = 0, checkpointWork = 0.0
    var checkpointFault: String?
    var providers: DriverPersonProviders {
        DriverPersonProviders(sample: {
            self.samples.append(self.now)
            self.lastKey = min(self.now, self.burstEnds)
            return DriverPersonSample(at: 100 + self.now, hidIdle: self.unrelated ? 0 : self.now - self.lastKey,
                frontmostPID: self.unrelated || self.pointer || self.leavesTarget && self.now >= 0.1 ? 999 : 321, pointerPID: self.pointer ? 321 : nil)
        }, now: { self.now }, wait: { seconds in self.pauses.append(seconds); self.now += seconds })
    }
    func run(budget: Double = 20) throws -> Double {
        let watch = DriverPersonWatch(sample: try providers.sample(), pid: 321, providers: providers, fresh: true)
        return try watch.waitForQuiet(remaining: { budget - self.now }, checkpoint: {
            self.checks += 1
            self.now += self.checkpointWork
            if self.now >= 0.1, let fault = self.checkpointFault { throw DriverFault(fault) }
        }, waiting: { _ in })
    }
}
do {
    let f = PersonWaitFixture(); let waited = try f.run()
    report("typing burst ends at 2 s then posts only after 1 s of quiet", waited >= 3000 && waited <= 3021 && f.now >= 3 && f.now <= 3.021)
    report("poll spacing never exceeds 20 ms", !f.pauses.isEmpty && f.pauses.allSatisfy { $0 > 0 && $0 <= 0.020001 })
}
do {
    let f = PersonWaitFixture(); f.checkpointWork = 0.005
    _ = try f.run()
    report("poll cadence includes checkpoint work", zip(f.samples.dropFirst(2), f.samples.dropFirst()).allSatisfy { $0 - $1 <= 0.020001 })
}
do {
    let f = PersonWaitFixture(); f.burstEnds = 100
    report("continuous typing refuses at the 8 s cap", code { _ = try f.run() } == "PERSON_TOOK_OVER" && f.now >= 7.999 && f.now <= 8.001)
}
do {
    let f = PersonWaitFixture(); f.burstEnds = 100
    report("deadline reserve refuses with person takeover at remaining minus 150 ms", code { _ = try f.run(budget: 0.5) } == "PERSON_TOOK_OVER" && f.now >= 0.349 && f.now <= 0.351)
}
do {
    let f = PersonWaitFixture(); f.pointer = true; f.burstEnds = 0
    report("pointer parked over covered target refuses at cap", code { _ = try f.run() } == "PERSON_TOOK_OVER" && f.now >= 7.999 && f.now <= 8.001)
}
do {
    let f = PersonWaitFixture(); f.unrelated = true
    report("typing outside a background target needs no wait", try f.run() == 0 && f.pauses.isEmpty)
}
do {
    let f = PersonWaitFixture(); f.leavesTarget = true; f.burstEnds = 0
    report("leaving the target still waits out its last HID event", try f.run() >= 1000 && f.now <= 1.021)
}
do {
    let f = PersonWaitFixture()
    let watch = DriverPersonWatch(sample: try f.providers.sample(), pid: 321, providers: f.providers, fresh: false)
    f.unrelated = true
    let initial = try watch.check(quietSeconds: 1.0)
    let waited = try watch.waitForQuiet(remaining: { 20 - f.now }, checkpoint: {}, waiting: { _ in })
    report("leaving between the token and initial guard preserves target HID recency", initial == "person-active" && waited >= 1000 && waited <= 1021)
}
for fault in ["SCREEN_LOCKED", "SECURE_INPUT_ACTIVE", "PERSON_HOLDS_MODIFIER", "IDENTITY_CHANGED"] {
    let f = PersonWaitFixture(); f.checkpointFault = fault
    report("wait checkpoint propagates \(fault) before posting", code { _ = try f.run() } == fault && f.now < 0.13)
}
do {
    var current = DriverPersonSample(at: 10, hidIdle: 10, frontmostPID: 321, pointerPID: nil)
    let watch = DriverPersonWatch(sample: current, pid: 321, providers: DriverPersonProviders(sample: { current }), fresh: false)
    current = DriverPersonSample(at: 10.1, hidIdle: 0, frontmostPID: 321, pointerPID: nil)
    report("post-admission takeover stays sticky without waiting", try watch.check() == "person-took-over" && watch.check() == "person-took-over")
}

final class WaitRecordingSink: DriverPointerSink, DriverPointerPrepared {
    var steps: [DriverPointerStep] = [], points: [CGPoint] = []
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self.steps = steps; return self }
    func post(_ index: Int) throws { points.append(steps[index].event.point) }
    func release(_ index: Int) throws {}
}
final class AdmissionFixture {
    var now = 0.0, held = false, changed = false, resume = false, realtime = false
    var resumeAfterQuiet = false, quietReads = 0
    var sampleOverride: DriverPersonSample?
    var mutation: (AdmissionFixture) -> Void = { _ in }
    let bounds: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
    let trees = NSMutableDictionary(), windows = NSMutableArray()
    let session = NSMutableDictionary(dictionary: ["kCGSSessionOnConsoleKey": true,
        "kCGSessionLoginDoneKey": true, "CGSSessionScreenIsLocked": false])
    let secure = NSMutableDictionary(dictionary: ["active": false])
    lazy var core: DriverCore = {
        let fixture: DriverObject = ["apps": [["id": "test.wait", "name": "Wait", "pid": 321, "processStart": "start"]],
            "windows": windows, "trees": trees, "session": session, "secureInput": secure]
        return DriverCore(fixture: fixture, personProviders: DriverPersonProviders(sample: {
            if self.now >= 1.2 { self.quietReads += 1 }
            return self.sampleOverride ?? DriverPersonSample(at: 100 + self.now, hidIdle: self.resume || self.resumeAfterQuiet && self.quietReads > 1 ? 0 : max(0, self.now - 0.2), frontmostPID: 321, pointerPID: nil)
        }, now: { self.now }, wait: { seconds in
            if self.realtime { Thread.sleep(forTimeInterval: seconds) }
            self.now += seconds
            if self.now >= 0.1 && !self.changed { self.changed = true; self.mutation(self) }
        }, heldModifiers: { self.held ? 0x20000 : 0 }))
    }()
    let binding: DriverObject = ["windowId": "42", "processStart": "start"]
    init() {
        windows.add(["windowId": "42", "processStart": "start", "pid": 321, "bundleId": "test.wait", "app": "Wait",
            "bounds": bounds, "onScreen": true, "hidden": false, "layer": 0])
        trees["42"] = tree()
    }
    func tree(focus: Bool = true, title: String = "One") -> DriverObject {
        ["AXRole": "AXWindow", "AXMain": true, "AXMinimized": false, "AXFullScreen": false, "pid": 321, "frame": bounds,
            "children": [["AXRole": "AXButton", "AXTitle": title, "AXFocused": focus, "AXEnabled": true,
                "frame": ["x": 10.0, "y": 20.0, "width": 20.0, "height": 20.0]]]]
    }
    func request(_ method: String, _ params: DriverObject, budgetMs: Int = 20000) throws -> DriverRequest {
        let nonce = String(repeating: "a", count: 64)
        return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": 1,
            "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + budgetMs], nonce: nonce, previous: 0)
    }
    func action(_ method: String = "click") throws -> DriverRequest {
        _ = try core.readTree(binding, request: request("getAXState", binding))
        let token = try core.person.state(window: core.inventory.bound(binding))["token"] as! String
        var params = binding; params["personToken"] = token; params["readId"] = core.maps["42"]!.id; params["args"] = [1]
        return try request(method, params)
    }
}
do {
    let f = AdmissionFixture(), action = try f.action()
    f.now = 0.04
    let outcome = code { try f.core.checkPersonBeforeInput(action) }
    report("typing between the person token and first input guard waits inside the call", outcome == "none" &&
        action.waitedForPersonMs >= 1000 && !action.inputAdmitted)
} catch { report("initial token fixture completed", false) }
do {
    let f = AdmissionFixture(), action = try f.action(), sink = WaitRecordingSink()
    try f.core.checkPersonBeforeInput(action)
    let context = try DriverPointer.context(request: action, core: f.core, geometry: nil,
        checkPerson: { try f.core.checkPersonBeforeInput(action) })
    let result = try DriverPointer.perform(method: "click", args: [1], context: context, sink: sink)
    let runtime = DriverRuntime(core: f.core, nonce: String(repeating: "a", count: 64))
    let reply = runtime.replyEnvelope(action, result: result)["result"] as! DriverObject
    report("real pointer action waits then clicks the original point once", sink.points == [CGPoint(x: 20, y: 30), CGPoint(x: 20, y: 30)] && action.inputAdmitted && f.now >= 1.2)
    report("success receipt reports wait shared with request copies", (reply["waitedForPersonMs"] as? Int ?? 0) >= 1200 && DriverRequest(copying: action, method: "settle", params: f.binding).waitedForPersonMs == action.waitedForPersonMs)
} catch { report("pointer fixture completed", false) }
for condition in ["focus", "lines", "modifiers", "lock", "secure", "bounds", "binding"] {
    let f = AdmissionFixture(), action = try f.action(condition == "secure" ? "typeText" : "click")
    f.mutation = { f in
        switch condition {
        case "focus": f.trees["42"] = f.tree(focus: false)
        case "lines": f.trees["42"] = f.tree(title: "Replaced")
        case "modifiers": f.held = true
        case "lock": f.session["CGSSessionScreenIsLocked"] = true
        case "secure": f.secure["active"] = true
        case "bounds":
            var window = f.windows[0] as! DriverObject
            window["bounds"] = ["x": 5.0, "y": 0.0, "width": 100.0, "height": 100.0]; f.windows[0] = window
        default:
            var window = f.windows[0] as! DriverObject; window["processStart"] = "replacement"; f.windows[0] = window
        }
    }
    let expected = ["focus": "STALE_READ", "lines": "STALE_READ", "modifiers": "PERSON_HOLDS_MODIFIER",
        "lock": "SCREEN_LOCKED", "secure": "SECURE_INPUT_ACTIVE", "bounds": "IDENTITY_CHANGED", "binding": "IDENTITY_CHANGED"][condition]!
    var fault: DriverFault?
    do { try f.core.checkPersonBeforeInput(action) } catch let error as DriverFault { fault = error }
    let reply = DriverRuntime(core: f.core, nonce: String(repeating: "a", count: 64)).replyEnvelope(action, error: fault)
    let error = reply["error"] as? DriverObject ?? [:]
    report("fresh \(condition) check refuses after waiting before any admission", fault?.code == expected && !action.inputAdmitted &&
        error["delivery"] as? String == "not-sent" && (error["waitedForPersonMs"] as? Int ?? 0) > 0)
}
do {
    let f = AdmissionFixture(), action = try f.action()
    try f.core.checkPersonBeforeInput(action)
    f.now += 0.1; f.resume = true
    report("resumed typing at the posting boundary refuses without admitting", code { try f.core.checkPerson(action) } == "PERSON_TOOK_OVER" && !action.inputAdmitted)
} catch { report("posting boundary fixture completed", false) }
do {
    let f = AdmissionFixture(), first = try f.action()
    try f.core.checkPersonBeforeInput(first); try first.admitInput()
    // A second native request in the same cell gets its own watch and token.
    f.now = 0; f.changed = false
    let second = try f.action()
    f.mutation = { $0.trees["42"] = $0.tree(title: "Changed between actions") }
    report("second action waits independently and refuses changed number lines", code { try f.core.checkPersonBeforeInput(second) } == "STALE_READ" &&
        second.waitedForPersonMs >= 1200 && !second.inputAdmitted && first.inputAdmitted)
} catch { report("second action fixture completed", false) }

// A token reporting a past takeover must refuse even after HID has been quiet.
// The retained read focuses field 1; the person's caret has since moved to 2.
for textBelief in ["always", "fallback"] { do {
    let f = AdmissionFixture()
    func fields(_ focused: Int) -> DriverObject {
        ["AXRole": "AXWindow", "AXMain": true, "AXMinimized": false, "AXFullScreen": false, "pid": 321, "frame": f.bounds,
         "children": (1...2).map { i -> DriverObject in ["AXRole": "AXTextField", "AXTitle": "Field \(i)",
             "AXValue": i == 2 ? "person text" : "", "AXFocused": i == focused, "AXEnabled": true,
             "frame": ["x": 10.0, "y": Double(i * 20), "width": 30.0, "height": 15.0]] }]
    }
    f.trees["42"] = fields(1)
    _ = try f.core.readTree(f.binding, request: f.request("getAXState", f.binding))
    f.sampleOverride = DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 321, pointerPID: nil)
    _ = try f.core.person.state(window: f.core.inventory.bound(f.binding))
    f.trees["42"] = fields(2)
    f.sampleOverride = DriverPersonSample(at: 105, hidIdle: 2, frontmostPID: 321, pointerPID: nil)
    let tookOver = try f.core.person.state(window: f.core.inventory.bound(f.binding))
    var params = f.binding; params["readId"] = f.core.maps["42"]!.id; params["personToken"] = tookOver["token"]; params["args"] = ["agent text"]
    let action = try f.request("typeText", params)
    var posts = 0
    let keyboard = DriverKeyboard(layout: { [:] }, makeEvent: { _ in { _ in posts += 1 } }, pause: {}, textBelief: { textBelief },
        beforeInput: { request, core in try core.checkPersonBeforeInput(request) })
    let outcome = code { _ = try keyboard.handle(action, core: f.core) }
    report("quiet took-over token never types at the person's moved caret [\(textBelief)] (\(outcome), posts=\(posts))", tookOver["reason"] as? String == "person-took-over" &&
        outcome == "PERSON_TOOK_OVER" && posts == 0 && !action.inputAdmitted)
} catch { report("quiet takeover fixture completed", false) } }

// Exercise UC2F through UC2B's real person guard, with fake text and event IO.
for mode in ["wait", "resume", "before-post", "parent-deny"] { do {
    let f = AdmissionFixture(), initial = try f.action("typeText")
    var params = initial.params; params["args"] = [String(repeating: "x", count: 64)]
    let action = try f.request("typeText", params)
    var authorizations = 0, downs = 0, ups = 0, value = ""
    action.parentAdmission = {
        authorizations += 1
        if mode == "parent-deny" { throw DriverFault("PERSON_TOOK_OVER") }
    }
    let focus = DriverFocusBelief(providers: DriverFocusProviders(
        secureInput: { false }, heldModifiers: { 0 },
        snapshot: { _ in DriverFocusSnapshot(pid: 999, processStart: "owner", window: "owner" as CFString) },
        belief: { _, _ in false }, makeEvent: { _ in { _ in preconditionFailure("Unexpected activation") } },
        now: { f.now }, pause: { f.now += $0 }, restore: { _, _, _ in true },
        frontmost: { DriverFocusSnapshot(pid: 999, processStart: "owner", window: nil) },
        // A pre-wait baseline must not survive into the text route.
        personInputSince: { started in started < 1.0 }), trace: { _ in })
    let keyboard = DriverKeyboard(layout: { fatalError("Unexpected layout read") }, makeEvent: { spec in { pid in
        precondition(pid == 321)
        if spec.type == "keyDown" { downs += 1; value += spec.unicode ?? "" }
        else {
            ups += 1
            if mode == "resume" { f.now += 0.04; f.resume = true }
        }
    } }, pause: {}, focus: focus, textBelief: { "fallback" },
        textSnapshot: { _, _, _, includeValue in
            if mode == "before-post", includeValue { f.now += 0.04; f.resume = true }
            return DriverTextSnapshot(element: "field" as CFString, window: "window" as CFString,
                value: includeValue ? value : nil,
                selection: includeValue ? NSRange(location: value.utf16.count, length: 0) : nil)
        }, inputMethod: { false }, beforeInput: { request, core in try core.checkPersonBeforeInput(request) })
    var result: DriverObject = [:]
    let outcome = code { result = try keyboard.handle(action, core: f.core) }
    let expectedDowns = mode == "wait" ? 2 : mode == "resume" ? 1 : 0
    report("Unicode real person guard \(mode)", outcome == (mode == "wait" ? "none" : "PERSON_TOOK_OVER") &&
        downs == expectedDowns && ups == expectedDowns && authorizations == 1 && action.waitedForPersonMs >= 1000 &&
        (mode != "wait" || result["charactersPosted"] as? Int == 64 && result["delivery"] as? String == "sent-verified"))
} catch { report("Unicode real person fixture completed [\(mode)]", false) } }
do {
    let f = AdmissionFixture(), action = try f.action()
    var authorizations = 0
    action.parentAdmission = { authorizations += 1; throw DriverFault("PERSON_TOOK_OVER") }
    report("parent admission after the wait can refuse before input", code { try f.core.checkPersonBeforeInput(action) } == "PERSON_TOOK_OVER" && authorizations == 1 && !action.inputAdmitted)
}
do {
    let f = AdmissionFixture(), action = try f.action()
    f.mutation = { _ in action.cancelInput() }
    report("cancel during wait refuses before quiet and before input", code { try f.core.checkPersonBeforeInput(action) } == "PERSON_TOOK_OVER" && f.now < 0.13 && !action.inputAdmitted)
}
do {
    let f = AdmissionFixture(); f.now = 2
    f.sampleOverride = DriverPersonSample(at: 102, hidIdle: 0.1, frontmostPID: 999, pointerPID: nil)
    let action = try f.action()
    try f.core.checkPersonBeforeInput(action)
    f.now += 0.05
    f.sampleOverride = DriverPersonSample(at: 102.05, hidIdle: 0.15, frontmostPID: 321, pointerPID: nil)
    let began = f.now
    report("later unadmitted guard refuses without waiting or reusing resolved points", code { try f.core.checkPersonBeforeInput(action) } == "PERSON_TOOK_OVER" && f.now == began && action.waitedForPersonMs == 0)
} catch { report("later guard fixture completed", false) }
do {
    let f = AdmissionFixture(), template = try f.action()
    let action = try f.request("click", template.params, budgetMs: 500)
    f.mutation = { $0.sampleOverride = DriverPersonSample(at: 101.2, hidIdle: 1, frontmostPID: 321, pointerPID: nil) }
    let outcome = code { try f.core.checkPersonBeforeInput(action) }
    report("post-wait budget floor refuses without retiring the helper (\(outcome), waited=\(action.waitedForPersonMs), cap=\(action.personWaitCapMs ?? -1))", outcome == "PERSON_TOOK_OVER" && !action.inputAdmitted)
    let reply = DriverRuntime(core: f.core, nonce: String(repeating: "a", count: 64)).replyEnvelope(action, error: DriverFault("PERSON_TOOK_OVER"))
    let error = reply["error"] as? DriverObject ?? [:]
    report("effective cap is reported as request budget minus reserve", (error["personWaitCapMs"] as? Int ?? -1) >= 340 && (error["personWaitCapMs"] as? Int ?? 1000) <= 350 && error["unhealthy"] as? Bool == false)
}
do {
    let f = AdmissionFixture()
    func tree(_ value: String) -> DriverObject {
        var root = f.tree(focus: false)
        var children = root["children"] as! [DriverObject]
        children.append(["AXRole": "AXTextField", "AXTitle": "Other", "AXFocused": true, "AXValue": value,
            "frame": ["x": 50.0, "y": 20.0, "width": 30.0, "height": 20.0]])
        root["children"] = children; return root
    }
    f.trees["42"] = tree("before")
    let action = try f.action()
    f.mutation = { $0.trees["42"] = tree("person typed") }
    report("unrelated field typing leaves original click target admissible", code { try f.core.checkPersonBeforeInput(action) } == "none" && action.waitedForPersonMs >= 1200)
}

do {
    let f = AdmissionFixture(), action = try f.action()
    f.resumeAfterQuiet = true
    report("final fresh sample rejects typing resumed after quiet", code { try f.core.checkPersonBeforeInput(action) } == "PERSON_TOOK_OVER" && !action.inputAdmitted)
}

do {
    let f = AdmissionFixture(), template = try f.action()
    let action = try f.request("click", template.params, budgetMs: 100)
    action.beginPersonWait()
    report("post-wait validation deadline refuses without an unhealthy deadline fault", code { try action.check() } == "PERSON_TOOK_OVER")
}

do {
    let f = AdmissionFixture()
    func tree(_ title: String) -> DriverObject {
        var root = f.tree()
        var children = root["children"] as! [DriverObject]
        children.append(["AXRole": "AXButton", "AXTitle": title, "AXFocused": false, "AXEnabled": true,
            "frame": ["x": 50.0, "y": 20.0, "width": 30.0, "height": 20.0]])
        root["children"] = children; return root
    }
    f.trees["42"] = tree("Destination")
    let template = try f.action("drag")
    var params = template.params; params["args"] = [1, 2]
    let action = try f.request("drag", params)
    f.mutation = { $0.trees["42"] = tree("Changed destination") }
    report("drag checks the original destination after waiting", code { try f.core.checkPersonBeforeInput(action) } == "STALE_READ" && !action.inputAdmitted)
}

if CommandLine.arguments.contains("--control-server") {
    let f = AdmissionFixture(); f.realtime = true
    let runtime = DriverRuntime(core: f.core, nonce: ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!)
    var posts = 0
    runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
    runtime.register(method: "personState") { request, core in try core.person.state(window: core.inventory.bound(request.params)) }
    runtime.register(method: "fixtureStats") { _, _ in ["posts": posts] }
    runtime.register(method: "ping") { _, _ in ["protocol": driverProtocol, "apiVersion": 2, "build": driverBuild, "methods": runtime.methods] }
    runtime.registerAction(method: "click") { request, core in
        try core.checkPersonBeforeInput(request)
        try request.admitInput(); posts += 1
        return ["window": try core.inventory.bound(request.params), "delivery": "sent-unverified", "retry": "read-first"]
    }
    DispatchQueue.global().async { runtime.serve() }
    RunLoop.main.run()
}
