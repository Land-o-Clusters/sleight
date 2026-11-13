// No live providers, windows or events. The AX stand-in consumes the supplied
// messaging budget before returning cannotComplete, as a synchronous read does.
while let line = readLine() {
    let control = try! DriverJSON.decode(Data(line.utf8))
    if control["micro"] as? Bool == true {
        let point = CGPoint(x: 5, y: 5)
        let rect = CGRect(x: 0, y: 0, width: 10, height: 10)
        var rows = [DriverObject]()
        for index in 0..<1000 {
            rows.append([kCGWindowLayer as String: index % 3 == 0 ? 0 : 1,
                kCGWindowBounds as String: rect.dictionaryRepresentation,
                kCGWindowOwnerPID as String: index + 42])
        }
        var durations = [String: [Double]](), matches = 0
        for _ in 0..<3 {
            for old in [true, false] {
                let providers = DriverPersonProviders(sample: {
                    let pid: Int?
                    if old {
                        let windows = rows.filter { driverInteger($0[kCGWindowLayer as String]) == 0 }
                        pid = windows.first { row in
                            guard let rect = row[kCGWindowBounds as String] as? DriverObject,
                                  let bounds = CGRect(dictionaryRepresentation: rect as CFDictionary) else { return false }
                            return bounds.contains(point)
                        }.flatMap { driverInteger($0[kCGWindowOwnerPID as String]) }
                    } else { pid = DriverPersonProviders.pointerPID(rows: rows, point: point) }
                    return DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 1, pointerPID: pid)
                })
                let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0]
                let window: DriverObject = ["windowId": "7", "pid": 42, "processStart": "start", "bounds": frame,
                    "onScreen": true, "layer": 0, "hidden": false]
                let core = DriverCore(fixture: ["apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "start"]],
                    "windows": [window], "trees": ["7": ["key": "original", "AXRole": "AXWindow", "AXMinimized": false,
                    "AXFullScreen": false, "frame": frame, "children": []]]], personProviders: providers)
                func request(_ id: Int, _ method: String, _ params: DriverObject) -> DriverRequest {
                    try! DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": "fixture", "id": id,
                        "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000],
                        nonce: "fixture", previous: id - 1)
                }
                let binding: DriverObject = ["windowId": "7", "processStart": "start"]
                _ = try! core.readTree(binding, request: request(1, "getAXState", binding))
                var params = binding
                params["readId"] = 1; params["args"] = ["s"]
                params["personToken"] = try! core.person.state(window: window)["token"]
                let input = request(2, "typeText", params), ticket = DriverStopTicket()
                input.stopCheck = { try ticket.check() }
                let guards = try! core.keyboardIntervalGuards(input)
                try! core.session.withDesktopRequest { checkpoint in
                    try input.withSessionCheck(checkpoint) {
                        let began = ProcessInfo.processInfo.systemUptime
                        for _ in 0..<1000 {
                            // The production check closure, including nested
                            // request, session, person and binding checks.
                            try input.check(); try guards.check(); try input.check(); matches += 1
                        }
                        durations[old ? "old" : "new", default: []].append((ProcessInfo.processInfo.systemUptime - began) * 1000 / 1000)
                    }
                }
            }
        }
        print(String(data: try! JSONSerialization.data(withJSONObject: ["msPerGuard": durations, "matches": matches,
            "rows": 1000, "guardsPerSample": 1000], options: [.sortedKeys]), encoding: .utf8)!)
        continue
    }
    if control["pointer"] as? Bool == true {
        let rect = CGRect(x: 0, y: 0, width: 10, height: 10).dictionaryRepresentation
        let rows: [DriverObject] = [
            [kCGWindowLayer as String: 1, kCGWindowBounds as String: rect, kCGWindowOwnerPID as String: 9],
            [kCGWindowLayer as String: 0, kCGWindowBounds as String: "bad", kCGWindowOwnerPID as String: 8],
            [kCGWindowLayer as String: 0, kCGWindowBounds as String: CGRect(x: 20, y: 20, width: 10, height: 10).dictionaryRepresentation, kCGWindowOwnerPID as String: 7],
            [kCGWindowLayer as String: 0, kCGWindowBounds as String: rect, kCGWindowOwnerPID as String: 42],
            [kCGWindowLayer as String: 0, kCGWindowBounds as String: rect, kCGWindowOwnerPID as String: 99]]
        print(String(data: try! JSONSerialization.data(withJSONObject: [
            "hit": DriverPersonProviders.pointerPID(rows: rows, point: CGPoint(x: 5, y: 5)) as Any,
            "miss": DriverPersonProviders.pointerPID(rows: rows, point: CGPoint(x: 100, y: 100)) as Any? ?? NSNull()], options: [.sortedKeys]), encoding: .utf8)!)
        continue
    }
    var time = 0.0, active = false, cleared = false, keys = 0, timeouts = 0
    var phase = "initial", records = [DriverObject](), reads = [DriverObject](), posts = [String]()
    let callEnd = (control["callMs"] as? Double ?? 30000) / 1000
    func read(_ kind: String, budget: Double) throws {
        guard budget > 0 else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=\(kind)-budget") }
        let cap = DriverFocusProviders.messagingBudget(budget)
        let option = phase + (kind == "snapshot" ? "SnapshotMs" : "BeliefMs")
        let cost = (control[option] as? Double ?? 0) / 1000
        let transient = phase == "clear" && kind == "belief" && timeouts < (driverInteger(control["clearTimeouts"]) ?? 0)
        reads.append(["phase": phase, "kind": kind, "atMs": time * 1000, "budgetMs": budget * 1000, "capMs": cap * 1000])
        time += min(cost, cap)
        if cost > cap + 0.000000001 || transient {
            timeouts += 1
            throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=\(kind)-timeout")
        }
    }
    let owner = DriverFocusSnapshot(pid: 1, processStart: "owner", window: "owner" as CFString)
    let focus = DriverFocusBelief(providers: DriverFocusProviders(
        secureInput: { false }, heldModifiers: { 0 }, snapshot: { budget in
            try read("snapshot", budget: budget); return owner
        }, belief: { _, budget in
            try read("belief", budget: budget)
            if !active { cleared = true; phase = "restore" }
            return active
        }, makeEvent: { activate in { _ in
            active = activate; phase = activate ? "active" : "clear"
            posts.append(activate ? "activate" : "deactivate")
        } }, now: { time }, pause: { time += $0 }, restore: { _, _, _ in false },
        frontmost: { owner }, personInputSince: { _ in false }), trace: { records.append($0) })
    var output: DriverObject
    do {
        let result = try focus.run(pid: 42, check: {}, identity: {}, remaining: { max(0, callEnd - time) },
            cleanupReserve: { (control["reserveMs"] as? Double ?? 20) / 1000 }) { guardInput, _ in
            phase = "body"; time += (control["bodyMs"] as? Double ?? 0) / 1000
            try guardInput(); keys += 1
            return [:]
        }
        output = ["ok": true, "result": result]
    } catch let failure as DriverFocusFault {
        let fault = failure.cause as? DriverFault
        output = ["ok": false, "error": ["code": fault?.code ?? "UNKNOWN", "message": fault?.message ?? "UNKNOWN", "unhealthy": failure.unhealthy]]
    } catch let fault as DriverFault { output = ["ok": false, "error": fault.json] }
    output["elapsedMs"] = time * 1000; output["keys"] = keys; output["reads"] = reads
    output["posts"] = posts; output["traces"] = records; output["cleared"] = cleared
    print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}
