// This entry point accepts fixture data over stdin. Every desktop boundary is fake.
// The alternate --fixture entry uses the unchanged production stdio dispatcher.
final class ParityPointerSink: DriverPointerSink, DriverPointerPrepared {
    var steps = [DriverPointerStep](), events = [DriverObject]()
    var window: DriverPointerWindow?
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        self.steps = steps; self.window = window; return self
    }
    func post(_ index: Int) throws {
        let event = steps[index].event
        events.append(["pid": Int(window!.pid), "windowID": Int(window!.windowID),
            "x": event.point.x, "y": event.point.y, "type": event.type.rawValue])
    }
    func release(_ index: Int) throws { events.append(["cleanup": true]) }
}

func parityRequest(_ id: Int, _ method: String, _ params: DriverObject) throws -> DriverRequest {
    try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": String(repeating: "a", count: 64),
        "id": id, "method": method, "params": params,
        "deadline": Int(Date().timeIntervalSince1970 * 1000) + 15000],
        nonce: String(repeating: "a", count: 64), previous: id - 1)
}

func parityRun(_ input: DriverObject) throws -> DriverObject {
    let binding: DriverObject = ["windowId": input["windowId"] ?? "7", "processStart": "1.2"]
    var fixture = input["fixture"] as! DriverObject
    let mode = input["mode"] as! String
    if mode == "renderer" {
        let frame = ((fixture["windows"] as! [DriverObject])[0])["bounds"]!
        let children = NSMutableArray()
        for i in 0..<10 { children.add(["AXRole": "AXGroup", "AXTitle": "Cold \(i)", "frame": frame]) }
        fixture["trees"] = ["7": ["AXRole": "AXWindow", "AXTitle": "Cold", "frame": frame, "children": children]]
        let core = DriverCore(fixture: fixture)
        let directory = input["stateDirectory"] as! String
        var clock = 0.0, waits = [Double](), writes = [[Any]](), reads = [String]()
        var attributes = ["AXManualAccessibility": false, "AXEnhancedUserInterface": false]
        // RTW2F removed recovery writes, so the store takes no recovery providers.
        let store = try DriverRendererRestoreStore(stateDirectory: directory,
            processState: { _ in .running("1.2") }, now: { clock })
        let lease = input["noLease"] as? Bool == true ? nil : DriverRendererLease(pid: 42, processStart: "1.2",
            bundleID: "test.parity", check: {}, restoreStore: store, armRestore: { _ in }, confirmRestored: { _ in })
        let providers = DriverRendererProviders(identity: {}, processIdentity: {}, read: { name in
            reads.append(name); return attributes[name]
        }, settable: { _ in true }, write: { name, value in
            writes.append([name, value]); attributes[name] = value
        }, remaining: { 15 - clock }, wait: { seconds in
            waits.append(seconds); clock += seconds
            if input["grow"] as? Bool == true && attributes["AXManualAccessibility"] == true {
                for i in 0..<498 { children.add(["AXRole": i == 497 ? "AXTextArea" : "AXGroup",
                    "AXTitle": i == 497 ? "Editor" : "Warm \(i)", "frame": frame]) }
            }
        }, processMatches: { true },
            // Offline: never read the Mac's real accessibility settings.
            assistive: DriverRendererAssistiveProviders(state: { _ in false }))
        let result = try core.readRendererTree(binding, request: parityRequest(1, "getAXState", binding),
            lease: lease, providers: providers)
        return ["result": result, "elements": core.maps["7"]!.elements.count,
            "writes": writes, "waits": waits, "attributeReads": reads, "attributes": attributes,
            "restoreRecords": try FileManager.default.contentsOfDirectory(atPath: directory + "/renderer-restore")
                .filter { $0.hasSuffix(".json") }]
    }
    let core = DriverCore(fixture: fixture)
    let read = try core.readTree(binding, request: parityRequest(1, "getAXState", binding))
    var params = binding; params["readId"] = read["readId"]; params["args"] = input["args"]
    let method = input["method"] as! String
    let request = try parityRequest(2, method, params)
    var result: DriverObject
    var front = 900, clock = 0.0, active = false, focusEvents = [DriverObject](), keyEvents = [DriverObject]()
    let sink = ParityPointerSink()
    do {
        if mode == "pointer" {
            let context = try DriverPointer.context(request: request, core: core, geometry: nil, checkPerson: {})
            result = try DriverPointer.perform(method: method, args: input["args"] as! [Any], context: context, sink: sink)
        } else {
            let focus = DriverFocusBelief(providers: DriverFocusProviders(secureInput: { false }, heldModifiers: { 0 },
                snapshot: { _ in DriverFocusSnapshot(pid: Int32(front), processStart: "owner", window: nil) },
                belief: { _, _ in active }, makeEvent: { state in { pid in
                    active = state; focusEvents.append(["pid": Int(pid), "active": state])
                } }, now: { clock }, pause: { clock += $0 }, restore: { previous, _, _ in
                    front = Int(previous.pid); return true
                }, frontmost: { DriverFocusSnapshot(pid: Int32(front), processStart: "owner", window: nil) },
                personInputSince: { _ in false }))
            let keyboard = DriverKeyboard(layout: { [:] }, makeEvent: { spec in { pid in
                var event = spec.json; event["pid"] = Int(pid); keyEvents.append(event)
            } }, pause: {}, focus: focus, beforeInput: { _, _ in })
            result = try keyboard.handle(request, core: core)
        }
        result = ["ok": true, "result": result]
    } catch let fault as DriverPointerFault { result = ["ok": false, "error": fault.json] }
    catch let fault as DriverKeyboardFault { result = ["ok": false, "error": fault.json] }
    catch let fault as DriverFault { result = ["ok": false, "error": fault.json] }
    result["pointerEvents"] = sink.events; result["keyEvents"] = keyEvents
    result["focusEvents"] = focusEvents; result["frontPID"] = front
    result["window"] = read["window"]
    return result
}

if CommandLine.arguments.dropFirst().first == "--fixture" {
    driverMain()
} else {
    guard Array(CommandLine.arguments.dropFirst()) == ["--parity-fixture"] else { exit(64) }
    while let line = readLine() {
        do {
            let output = try parityRun(DriverJSON.decode(Data(line.utf8)))
            print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), as: UTF8.self))
        } catch let fault as DriverFault { fputs("Parity fixture: \(fault.code): \(fault.message)\n", stderr); exit(65) }
        catch { fputs("Invalid parity fixture.\n", stderr); exit(65) }
    }
}
