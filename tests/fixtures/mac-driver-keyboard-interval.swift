// The complete driver is compiled, but only fixture inventory and injected OS
// providers run. No NSApplication, windows, input posts or live AX reads.
while let line = readLine() {
    let control = try! DriverJSON.decode(Data(line.utf8))
    let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
    let windows = NSMutableArray(array: [["windowId": "7", "pid": 42, "processStart": "start", "bounds": frame,
                                         "onScreen": true, "layer": 0, "hidden": false]])
    let trees = NSMutableDictionary(dictionary: ["7": ["key": "original", "AXRole": "AXWindow", "AXMinimized": false,
                                                      "AXFullScreen": false, "frame": frame, "children": []]])
    var fixture: DriverObject = [
        "apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "start"]],
        "windows": windows, "trees": trees]
    if control["censusTrap"] as? Bool == true { fixture["windowSnapshots"] = [windows, windows, windows, []] }
    var personSample = DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 1, pointerPID: nil)
    let core = DriverCore(fixture: fixture, personProviders: DriverPersonProviders(sample: { personSample }))
    var time = 0.0, active = false, downs = 0, ups = 0, guards = 0, intervals = 0
    var stopped = false, secure = false, person = false, cleared = false
    var stoppedAt: Double?, stopObservedAt: Double?, betweenPersonAt: Double?
    var held: UInt64 = 0
    var records = [DriverObject](), posts = [String]()
    let focus = DriverFocusBelief(providers: DriverFocusProviders(
        secureInput: { secure }, heldModifiers: { held }, snapshot: { budget in
            guard budget > 0 else { throw DriverFault("KEY_FOCUS_UNAVAILABLE", "KEY_FOCUS_UNAVAILABLE step=snapshot-budget") }
            if cleared { time += (control["restoreMs"] as? Double ?? 0) / 1000 }
            return DriverFocusSnapshot(pid: 1, processStart: "owner", window: "owner" as CFString)
        }, belief: { _, _ in
            if !active { time += (control["clearMs"] as? Double ?? 0) / 1000; cleared = true }
            return active
        }, makeEvent: { activation in { _ in
            active = activation; posts.append(activation ? "activate" : "deactivate")
            if !activation {
                time += (control["deactivateMs"] as? Double ?? 0) / 1000
                if intervals == 1, control["personBetween"] as? Bool == true { betweenPersonAt = time; time += 0.001 }
                if intervals == 1, control["stopBetween"] as? Bool == true { stopped = true; stoppedAt = time }
            }
            if activation {
                cleared = false; intervals += 1
                time += (control["activationMs"] as? Double ?? 0) / 1000
                if intervals == 1 { time += (control["firstActivationMs"] as? Double ?? 0) / 1000 }
            }
        } }, now: { time }, pause: { time += $0 }, restore: { _, _, _ in false },
        frontmost: { DriverFocusSnapshot(pid: 1, processStart: "owner", window: nil) },
        personInputSince: { since in person || betweenPersonAt.map { $0 >= since } == true }), trace: { records.append($0) })
    let keyboard = DriverKeyboard(layout: { ["s": DriverKeyboardMapping(keyCode: 1, modifiers: []), "S": DriverKeyboardMapping(keyCode: 1, modifiers: ["shift"])] },
        makeEvent: { spec in { _ in
            if spec.type == "keyDown", spec.unicode != nil {
                downs += 1
                if downs == driverInteger(control["stallAt"]) { time += (control["stallMs"] as? Double ?? 401) / 1000 }
                if downs == driverInteger(control["personAt"]) { person = true }
                if downs == driverInteger(control["watchAt"]) {
                    personSample = DriverPersonSample(at: 101, hidIdle: 0, frontmostPID: 42, pointerPID: 42)
                }
                if downs == driverInteger(control["stopAt"]) { stopped = true; stoppedAt = time }
                if downs == driverInteger(control["secureAt"]) { secure = true }
                if downs == driverInteger(control["modifierAt"]) { held = 0x100000 }
                if downs == driverInteger(control["rootAt"]), var tree = trees["7"] as? DriverObject {
                    tree["key"] = "replacement"; trees["7"] = tree
                }
                if downs == driverInteger(control["pidAt"]), var window = windows[0] as? DriverObject {
                    window["pid"] = 99; windows[0] = window; _ = core.inventory.state()
                }
                if downs == driverInteger(control["startAt"]), var window = windows[0] as? DriverObject {
                    window["processStart"] = "replacement"; windows[0] = window; _ = core.inventory.state()
                }
                if downs == driverInteger(control["hiddenAt"]), var window = windows[0] as? DriverObject {
                    window["hidden"] = true; windows[0] = window; _ = core.inventory.state()
                }
                if downs == driverInteger(control["offSpaceAt"]), var window = windows[0] as? DriverObject {
                    window["onScreen"] = false; windows[0] = window; _ = core.inventory.state()
                }
                if downs == driverInteger(control["moveAt"]), var window = windows[0] as? DriverObject {
                    window["bounds"] = ["x": 1.0, "y": 0.0, "width": 100.0, "height": 100.0]
                    windows[0] = window; _ = core.inventory.state()
                }
            }
            if spec.type == "keyUp", spec.unicode != nil { ups += 1 }
        } }, pause: { time += (control["keyMs"] as? Double ?? 0) / 1000 }, focus: focus,
        intervalGuards: control["fastGuard"] as? Bool == true ? { request, core in try core.keyboardIntervalGuards(request) } : nil,
        beforeInput: { _, _ in
            guards += 1; time += (control[active ? "guardMs" : "admissionGuardMs"] as? Double ?? control["guardMs"] as? Double ?? 0) / 1000
        })
    let binding: DriverObject = ["windowId": "7", "processStart": "start"]
    func request(_ id: Int, _ method: String, _ params: DriverObject) throws -> DriverRequest {
        try DriverRequest(["protocol": "sleight.driver/1", "platform": "darwin", "nonce": String(repeating: "a", count: 64),
                           "id": id, "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000],
                          nonce: String(repeating: "a", count: 64), previous: id - 1)
    }
    _ = try core.readTree(binding, request: request(1, "getAXState", binding))
    var params = binding
    params["readId"] = 1
    params["personToken"] = try core.person.state(window: ["windowId": "7", "processStart": "start", "pid": 42])["token"]
    params["args"] = [control["text"] as? String ?? String(repeating: "s", count: driverInteger(control["count"]) ?? 24)]
    let input = try request(2, "typeText", params)
    input.stopCheck = {
        if stopped { stopObservedAt = time; throw DriverFault("USER_STOPPED") }
        if active { time += (control["requestCheckMs"] as? Double ?? 0) / 1000 }
    }
    var output: DriverObject
    do { output = ["ok": true, "result": try keyboard.handle(input, core: core)] }
    catch let fault as DriverKeyboardFault { output = ["ok": false, "error": fault.json] }
    catch let fault as DriverFault { output = ["ok": false, "error": fault.json] }
    output["downs"] = downs; output["ups"] = ups; output["guards"] = guards
    output["elapsedMs"] = time * 1000; output["traces"] = records; output["posts"] = posts
    if let stoppedAt = stoppedAt, let observed = stopObservedAt { output["stopDelayMs"] = (observed - stoppedAt) * 1000 }
    print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}
