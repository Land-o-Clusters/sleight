// Offline stdin fixture. Every action uses fixture AX, layout and event adapters.
// Shadow AppKit's board even if a regression accidentally selects systemCount.
enum NSPasteboard {
    struct Board { var changeCount: Int { fatalError("real board adapter forbidden") } }
    static var general: Board { Board() }
}
func fixtureLayout(_ raw: Any?) -> [String: DriverKeyboardMapping] {
    var layout = [String: DriverKeyboardMapping]()
    for (key, value) in raw as? DriverObject ?? [:] {
        let value = value as! DriverObject
        layout[key] = DriverKeyboardMapping(keyCode: driverInteger(value["keyCode"])!,
            modifiers: value["modifiers"] as? [String] ?? [], safetyCharacters: value["safetyCharacters"] as? [String] ?? [])
    }
    return layout
}
func fixtureRequest(_ method: String, args: [Any], read: Bool = false) throws -> DriverRequest {
    let nonce = String(repeating: "a", count: 64)
    return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
        "id": 1, "method": method, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000,
        "params": ["windowId": "7", "processStart": "start", "readId": 1, "args": args, "read": read ? "full" : "none"]],
        nonce: nonce, previous: 0)
}
func fixtureCore(_ node: DriverObject) throws -> DriverCore {
    let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
    var child = node; child["frame"] = ["x": 10.0, "y": 10.0, "width": 20.0, "height": 20.0]
    let core = DriverCore(fixture: ["apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "start"]],
        "windows": [["windowId": "7", "pid": 42, "processStart": "start", "app": "Fixture", "title": "Draft", "bounds": frame,
            "bundleId": "test.fake", "identityVerified": true, "onScreen": true, "layer": 0, "hidden": false]],
        "trees": ["7": ["AXRole": "AXWindow", "AXTitle": "Draft", "frame": frame,
            "AXMinimized": false, "AXFullScreen": false, "children": [child]]]])
    _ = try core.readTree(["windowId": "7", "processStart": "start"], request: fixtureRequest("getAXState", args: []))
    return core
}
final class FixturePointerSink: DriverPointerSink, DriverPointerPrepared {
    var posts = 0
    var onPost: () -> Void = {}
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws { posts += 1; onPost() }
    func release(_ index: Int) throws { posts += 1 }
}
func fixtureFault(_ error: Error) -> DriverObject {
    if let error = error as? DriverKeyboardFault { return error.json }
    if let error = error as? DriverPointerFault { return error.json }
    return (error as? DriverFault)?.json ?? ["code": "FIXTURE_ERROR"]
}
// Real semantic handlers with fake AX storage. A write is counted only when
// the handler reaches its injected AX mutation, never at fixture admission.
final class FixtureSemantic {
    let core: DriverCore
    var values: DriverObject = [kAXValueAttribute: "Draft value", kAXSelectedTextRangeAttribute: [0, 5]]
    var writes = 0
    var onWrite: () -> Void = {}
    init() throws { core = try fixtureCore(["AXRole": "AXTextArea", "AXTitle": "Draft"]) }
    func driver() -> DriverSemantic {
        let root = core.maps["7"]!.root, child = core.maps["7"]!.elements[1]!.node
        return DriverSemantic(access: DriverSemanticAccess(attributes: { [self] node, names, request in
            var attrs = try node.attributes(names, request: request)
            if node.same(child) { for name in names { if let value = values[name] { attrs[name] = value } } }
            return attrs
        }, isSettable: { _, _, _ in true }, set: { [self] _, name, value, _ in
            writes += 1
            if name == kAXSelectedTextAttribute {
                let range = values[kAXSelectedTextRangeAttribute] as! [Int], text = value as! String
                values[kAXValueAttribute] = (values[kAXValueAttribute] as! NSString).replacingCharacters(
                    in: NSRange(location: range[0], length: range[1]), with: text)
                values[kAXSelectedTextRangeAttribute] = [range[0] + text.utf16.count, 0]
            } else { values[name] = value }
            onWrite()
        }, actionNames: { _, _ in [] }, secondaryActions: { _, _ in [] },
            perform: { _, _, _ in fatalError("unexpected semantic press") },
            parent: { node, _ in node.same(root) ? nil : root }, children: { _, _ in [] }, focused: { _, _ in child }),
            qualification: { _, _, _, _ in true }, beforeInput: { _, _ in })
    }
}
// Exercise the same runtime dispatch and reply construction used by serve(),
// with one fake server shared by two independently remembered runtimes.
func fixtureProtocol(_ config: DriverObject) throws -> DriverObject {
    let semantic = try FixtureSemantic(), core = semantic.core
    var board = 10, reads = 0, clock = 1.0, personAt = 0.0, posts = 0
    var replies = [DriverObject]()
    func makeRuntime() -> DriverRuntime {
        DriverRuntime(core: core, nonce: String(repeating: "a", count: 64), clipboardCount: {
            reads += 1
            if driverInteger(config["throwAt"]) == reads { throw DriverFault("AX_UNAVAILABLE") }
            return board
        }, now: { clock }, personInputSince: { personAt > $0 })
    }
    var runtimes = ["A": makeRuntime(), "B": makeRuntime()]
    for instruction in config["steps"] as? [DriverObject] ?? [] {
        clock += 1
        let name = instruction["session"] as? String ?? "A"
        switch instruction["do"] as? String ?? "" {
        case "write": board = driverInteger(instruction["count"]) ?? board + 1
        case "person": personAt = clock
        case "restart": runtimes[name] = makeRuntime()
        case "action", "read", "compound":
            let command = instruction["do"] as! String
            let method = instruction["method"] as? String ?? (command == "read" ? "getAXState" : "click")
            let runtime = runtimes[name]!, request = try fixtureRequest(method, args: [])
            let beforePosts = posts, beforeReads = reads
            runtime.register(method: method) { original, _ in
                if command == "read" { return ["text": "fake read"] }
                let steps = command == "compound" ? 3 : 1
                for index in 1...steps {
                    var params = original.params
                    if command == "compound" { params["args"] = [1, "step \(index)"] }
                    let copy = DriverRequest(copying: original, method: command == "compound" ? "setValue" : method, params: params)
                    if command == "compound" {
                        semantic.onWrite = { posts += 1 }
                        _ = try semantic.driver().handle(copy, core: core)
                    } else if method == "paste" {
                        _ = try DriverStrictText.dispatch(copy, text: "text", format: "text", resolve: { .selectedText },
                            admit: { _ in }, send: { _ in posts += 1 }, observe: { _ in [:] })
                    } else {
                        if instruction["swallow"] as? Bool == true { try? copy.admitInput() }
                        if instruction["swallowReturn"] as? Bool == true {
                            try? copy.admitInput(); return ["ok": false]
                        }
                        try copy.admitInput(); try copy.admitInput(); posts += 1
                    }
                    if driverInteger(instruction["writeAtStep"]) == index {
                        board = driverInteger(instruction["count"]) ?? board + 1
                    }
                    if instruction["person"] as? Bool == true { personAt = clock }
                    if command == "compound" { try copy.checkClipboardStep(after: index) }
                }
                if instruction["fail"] as? Bool == true { throw DriverFault("PERSON_TOOK_OVER") }
                return ["delivery": "sent-unverified", "retry": "read-first"]
            }
            var result: DriverObject?, failure: DriverFault?
            do { result = try runtime.handle(request) }
            catch let error as DriverFault { failure = error }
            var reply = runtime.replyEnvelope(request, result: result, error: failure)
            reply["events"] = posts - beforePosts; reply["countReads"] = reads - beforeReads
            reply["admitted"] = request.inputAdmitted; replies.append(reply)
        default: throw DriverFault("INVALID_PARAMS")
        }
    }
    return ["replies": replies, "countReads": reads, "events": posts]
}
func fixtureRun(_ config: DriverObject) throws -> DriverObject {
    let op = config["op"] as? String ?? "key"
    if op == "protocol" { return try fixtureProtocol(config) }
    if op == "event" {
        let channel = Pipe()
        let pipe = DriverActionPipe(descriptor: channel.fileHandleForWriting.fileDescriptor, nonce: String(repeating: "a", count: 64))
        let state = DriverActionState(id: 1, method: "click", args: [], pipe: pipe)
        state.admit()
        state.finish(result: ["delivery": "sent-unverified", "clipboardChanged": true], error: nil, admitted: true)
        let data = channel.fileHandleForReading.availableData
        return ["records": try String(decoding: data, as: UTF8.self).split(separator: "\n").map { try DriverJSON.decode(Data($0.utf8)) }]
    }
    var board = driverInteger(config["count"]) ?? 10, countReads = 0
    var runtime: DriverRuntime?
    func makeRuntime(_ core: DriverCore) -> DriverRuntime {
        let value = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64), clipboardCount: {
            countReads += 1
            if driverInteger(config["throwAt"]) == countReads { throw DriverFault("AX_UNAVAILABLE") }
            return board
        }, now: { 1 }, personInputSince: { _ in false })
        value.register(method: "settle") { _, _ in ["settled": true, "reason": "quiet"] }
        runtime = value; return value
    }
    func wrote() { if config["writeOnPost"] as? Bool == true { board = driverInteger(config["writtenCount"]) ?? board + 1 } }
    func execute(_ request: DriverRequest, core: DriverCore, register: Bool = true, _ body: @escaping () throws -> DriverObject) -> DriverObject {
        var result: DriverObject?, failure: DriverFault?, rawError: DriverObject?
        do {
            if config["integrated"] as? Bool == true {
                let active = runtime ?? makeRuntime(core)
                if register { active.register(method: request.method) { _, _ in try body() } }
                result = try active.handle(request)
            } else { result = try body() }
        } catch {
            rawError = fixtureFault(error)
            if let fault = error as? DriverFault { failure = fault }
            else {
                var fault = DriverFault(rawError?["code"] as? String ?? "DRIVER_INTERNAL")
                fault.disposition = rawError ?? [:]; failure = fault
            }
        }
        var out: DriverObject
        if let runtime = runtime {
            out = runtime.replyEnvelope(request, result: result, error: failure)
            out["countReads"] = countReads
        } else if let rawError = rawError { out = ["ok": false, "error": rawError] }
        else { out = ["ok": true, "result": result ?? [:]] }
        out["admitted"] = request.inputAdmitted
        return out
    }
    let layout = fixtureLayout(config["layout"])
    let attrs = config["attrs"] as? DriverObject ?? ["AXRole": "AXButton", "AXTitle": "Neutral"]
    if op == "labels" {
        return ["refused": (config["labels"] as? [String] ?? []).map { label in
            do { try DriverKeyboard.refuseClipboardLabel(label); return false } catch { return true }
        }]
    }
    if op == "cost" {
        let iterations = 10000, rounds = 5
        let request = try fixtureRequest("click", args: [1])
        let node = DriverNode(fake: ["AXRole": "AXMenuItem", "AXTitle": "Paste", "AXMenuItemCmdChar": "V",
            "AXMenuItemCmdVirtualKey": 9, "AXMenuItemCmdModifiers": 0], path: "fixture")
        var checksum = 0, reads = 0, attributes = 0, hitTests = 0
        let counter = DriverClipboardWatch(count: { reads += 1; return 10 }, now: { 0 }, personInputSince: { _ in false })
        func sample(_ body: () throws -> Void) throws -> [Double] {
            var samples = [Double]()
            for _ in 0..<rounds {
                let start = DispatchTime.now().uptimeNanoseconds
                for _ in 0..<iterations { try body() }
                samples.append(Double(DispatchTime.now().uptimeNanoseconds - start) / Double(iterations))
            }
            return samples
        }
        let baseline = try sample { checksum += 1 }
        let counts = try sample {
            var admission: DriverClipboardWatch.Admission?
            try counter.admit(&admission); if try counter.finish(admission) { checksum += 1 }
        }
        let attribute = try sample { attributes += 1; checksum += try node.attributes(DriverKeyboard.clipboardMenuAttributes, request: request).count }
        let hitTest: (CGPoint) -> DriverNode = { _ in hitTests += 1; return node }
        let hit = try sample { checksum += hitTest(.zero).path.count }
        let combined = try sample {
            var admission: DriverClipboardWatch.Admission?; try counter.admit(&admission)
            let target = hitTest(.zero); attributes += 1
            try DriverKeyboard.refuseClipboardMenu(target.attributes(DriverKeyboard.clipboardMenuAttributes, request: request), layout: layout)
            if try counter.finish(admission) { checksum += 1 }
        }
        let core = try fixtureCore(["AXRole": "AXButton", "AXTitle": "Neutral"])
        var integratedReads = 0
        let idle = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64), clipboardCount: { fatalError("read-only baseline") })
        let watched = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64), clipboardCount: { integratedReads += 1; return 10 },
            now: { 0 }, personInputSince: { _ in false })
        idle.register(method: "click") { _, _ in ["delivery": "sent-unverified", "retry": "read-first"] }
        watched.register(method: "click") { request, _ in
            try request.admitInput(); return ["delivery": "sent-unverified", "retry": "read-first"]
        }
        func idleInput() throws {
            let request = try fixtureRequest("click", args: [1])
            checksum += idle.replyEnvelope(request, result: try idle.handle(request)).count
        }
        func watchedInput() throws {
            let request = try fixtureRequest("click", args: [1])
            checksum += watched.replyEnvelope(request, result: try watched.handle(request)).count
        }
        var inputBaseline = [Double](), inputWatched = [Double]()
        for round in 0..<rounds {
            for enabled in round % 2 == 0 ? [false, true] : [true, false] {
                let start = DispatchTime.now().uptimeNanoseconds
                for _ in 0..<iterations { if enabled { try watchedInput() } else { try idleInput() } }
                let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / Double(iterations)
                if enabled { inputWatched.append(elapsed) } else { inputBaseline.append(elapsed) }
            }
        }
        return ["iterationsPerRound": iterations, "rounds": rounds, "baselineNs": baseline, "twoCountReadsNs": counts,
            "attributeBatchNs": attribute, "hitTestNs": hit, "combinedGuardNs": combined,
            "inputActionBaselineNs": inputBaseline, "watchedInputActionNs": inputWatched, "integratedCountReads": integratedReads,
            "countReads": reads, "attributeReads": attributes, "hitTests": hitTests, "checksum": checksum]
    }
    if op == "translate" {
        let translations = config["translations"] as? [String: String] ?? [:]
        let built = DriverKeyboard.layoutMappings { code, flags in translations["\(code):\(flags)"] }
        return ["codes": DriverKeyboard.clipboardKeyCodes(built).sorted(), "layout": built.mapValues {
            ["keyCode": $0.keyCode, "modifiers": $0.modifiers, "safetyCharacters": $0.safetyCharacters] as DriverObject
        }]
    }
    if op == "menu" {
        do { try DriverKeyboard.refuseClipboardMenu(attrs, layout: layout); return ["ok": true, "events": 0] }
        catch { return ["ok": false, "error": fixtureFault(error), "events": 0] }
    }
    if op == "local" {
        let request = try fixtureRequest("localTool", args: [])
        let io = DriverLocalIO(request, fixture: [:])
        let core = try fixtureCore(attrs)
        var out = execute(request, core: core) {
            try DriverLocalNode(fake: attrs, io: io).perform("AXPress"); wrote()
            return ["ok": true, "pressed": true]
        }
        out["events"] = io.events.count; return out
    }
    if op == "notification" {
        let request = try fixtureRequest("localTool", args: [])
        var banner = attrs
        let label = config["label"] as? String ?? "Activate"
        banner["actions"] = ["Name:\(label)\nTarget:1"]
        banner["AXChildren"] = [["AXRole": "AXStaticText", "AXValue": "Fixture alert"]]
        let io = DriverLocalIO(request, fixture: ["apps": [["name": "NotificationCenter",
            "tree": ["AXWindows": [["AXChildren": [banner]]]]]]])
        let core = try fixtureCore(attrs)
        var out = execute(request, core: core) {
            let result = try DriverLocalTools().run("menubar.js", ["caller": "notifications", "op": "notify-press", "banner": 0, "button": label], io)
            wrote(); return result
        }
        out["events"] = io.events.count; return out
    }
    if op == "menuRoute" {
        let request = try fixtureRequest("localTool", args: [])
        let io = DriverLocalIO(request, fixture: ["apps": [["name": "Fixture", "appId": "test.fake", "pid": 42]], "tree": attrs])
        do {
            let result = try DriverLocalTools().run("menubar.js", ["caller": "menu_bar", "op": "choose", "app": "Fixture", "path": ["Edit", "Copy"]], io)
            return ["ok": true, "result": result, "events": io.events.count]
        } catch { return ["ok": false, "errorText": String(describing: error), "events": io.events.count] }
    }
    if op == "watch" {
        var board = driverInteger(config["count"]) ?? 10, reads = 0, time = 1.0, person = false
        var changes = [Bool](), faults = [DriverObject](), trace = [String]()
        var admissions = [String: DriverClipboardWatch.Admission]()
        func makeWatch() -> DriverClipboardWatch {
            DriverClipboardWatch(count: {
                reads += 1
                if driverInteger(config["throwAt"]) == reads { throw DriverFault("AX_UNAVAILABLE") }
                return board
            }, now: { time }, personInputSince: { _ in person })
        }
        var watches = ["A": makeWatch(), "B": makeWatch()]
        for instruction in config["steps"] as? [DriverObject] ?? [] {
            let name = instruction["session"] as? String ?? "A", command = instruction["do"] as! String
            time += 1
            do {
                switch command {
                case "admit":
                    var ticket = admissions[name]; try watches[name]!.admit(&ticket); admissions[name] = ticket
                case "finish":
                    changes.append(try watches[name]!.finish(admissions[name])); admissions[name] = nil
                case "step":
                    let changed = try watches[name]!.changed(admissions[name]!); changes.append(changed)
                    if changed { trace.append("stop-before-next-step"); return ["changes": changes, "faults": faults, "reads": reads, "trace": trace] }
                case "write": board = driverInteger(instruction["count"]) ?? board + 1
                case "person": person = instruction["value"] as? Bool ?? true
                case "restart": watches[name] = makeWatch(); admissions[name] = nil
                default: break
                }
                trace.append(command)
            } catch { faults.append(fixtureFault(error)); trace.append("refused-\(command)") }
        }
        return ["changes": changes, "faults": faults, "reads": reads, "trace": trace]
    }
    if op == "pointer" {
        let core = try fixtureCore(attrs), method = config["method"] as? String ?? "click"
        let initial = try fixtureRequest(method, args: config["args"] as? [Any] ?? [[20, 20]])
        var params = initial.params
        if ["click", "doubleClick", "rightClick"].contains(method) {
            params["coordinateReadId"] = 1
            core.coordinateMaps[1] = core.maps["7"]
        }
        let request = DriverRequest(copying: initial, method: method, params: params)
        let sink = FixturePointerSink(); sink.onPost = wrote
        var out = execute(request, core: core) {
            let context = try DriverPointer.context(request: request, core: core,
                geometry: DriverPointerGeometry(bounds: CGRect(x: 0, y: 0, width: 100, height: 100), pixelWidth: 100, pixelHeight: 100),
                checkPerson: {}, hitTest: { point in
                    var hit = point.x >= 30 ? config["endAttrs"] as? DriverObject ?? attrs : config["startAttrs"] as? DriverObject ?? attrs
                    hit["pid"] = 42
                    hit["frame"] = ["x": 10.0, "y": 10.0, "width": 20.0, "height": 20.0]
                    if hit["AXParent"] == nil { hit["AXParent"] = ["AXRole": "AXWindow", "pid": 42] }
                    return DriverNode(fake: hit, path: "7/0")
                })
            return try DriverPointer.perform(method: method, args: request.params["args"] as! [Any], context: context, sink: sink)
        }
        out["events"] = sink.posts; return out
    }
    if op == "semantic" {
        if let method = config["method"] as? String, ["setValue", "selectText", "paste"].contains(method) {
            let semantic = try FixtureSemantic(), driver = semantic.driver()
            semantic.onWrite = wrote
            let args: [Any] = method == "paste" ? ["updated"] : [1, method == "selectText" ? "Draft" : "updated"]
            let request = try fixtureRequest(method, args: args)
            var out = execute(request, core: semantic.core) { try driver.handle(request, core: semantic.core) }
            out["events"] = semantic.writes
            if let runtime = runtime {
                let before = countReads
                runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
                let read = DriverRequest(copying: try fixtureRequest("getAXState", args: []), method: "getAXState",
                    params: ["windowId": "7", "processStart": "start"])
                let result = try runtime.handle(read)
                out["readReply"] = runtime.replyEnvelope(read, result: result)
                out["readCountReads"] = countReads - before
            }
            return out
        }
        let core = try fixtureCore(attrs), root = core.maps["7"]!.root
        var mutations = 0
        let access = DriverSemanticAccess(attributes: { node, names, request in
            var result = try node.attributes(names, request: request)
            if mutations > 0, names.contains(kAXTitleAttribute), let title = config["afterTitle"] { result[kAXTitleAttribute] = title }
            return result
        }, isSettable: { _, _, _ in false },
            set: { _, _, _, _ in mutations += 1; wrote() }, actionNames: { _, _ in ["AXActivate"] },
            secondaryActions: { _, _ in [("Activate", "AXActivate")] }, perform: { _, _, _ in mutations += 1; wrote() },
            parent: { node, _ in node.same(root) ? nil : root }, children: { _, _ in [] }, focused: { _, _ in nil })
        let semantic = DriverSemantic(access: access, beforeInput: { _, _ in })
        let request = try fixtureRequest("performSecondaryAction", args: [1, config["action"] as? String ?? "Activate"])
        var out = execute(request, core: core) { try semantic.handle(request, core: core) }
        out["events"] = mutations; return out
    }
    let core = try fixtureCore(["AXRole": "AXButton", "AXTitle": "Neutral"])
    var events = [DriverObject](), menuPresses = 0, active = false, clock = 0.0
    let focus = DriverFocusBelief(providers: DriverFocusProviders(secureInput: { false },
        heldModifiers: { UInt64(driverInteger(config["personModifiers"]) ?? 0) },
        snapshot: { _ in DriverFocusSnapshot(pid: 1, processStart: "person", window: nil) },
        belief: { _, _ in active && config["fallback"] as? Bool != true },
        makeEvent: { state in { _ in active = state } }, now: { clock }, pause: { clock += $0 },
        restore: { _, _, _ in false }, frontmost: { DriverFocusSnapshot(pid: 1, processStart: "person", window: nil) },
        personInputSince: { _ in false }))
    var activeLayout = layout, layoutReads = 0
    let keyboard = DriverKeyboard(layout: { layoutReads += 1; return activeLayout }, makeEvent: { spec in { _ in
        events.append(spec.json); wrote()
        if let swapped = config["swapLayout"] { activeLayout = fixtureLayout(swapped) }
    } },
        ladder: { config["strategy"] as? String }, pause: {}, focus: focus,
        menuItems: { _, _, _ in
            guard let menu = config["menu"] as? DriverObject else { return [] }
            return [DriverKeyboardMenuItem(attributes: menu, enabled: true, press: { _, before in
                try DriverKeyboard.validateMenuAttributes(config["menuAtPress"] as? DriverObject ?? menu, original: menu)
                try before(); menuPresses += 1; wrote()
            })]
        }, beforeInput: { _, _ in })
    if config["integrated"] as? Bool == true {
        keyboard.register(in: makeRuntime(core), fault: { failure in
            var fault = DriverFault(failure.code, unhealthy: failure.unhealthy)
            fault.disposition = failure.json.filter { !["code", "message", "unhealthy"].contains($0.key) }
            return fault
        })
    }
    let calls = config["calls"] as? [DriverObject] ?? [["method": "pressKey", "args": [config["chord"] as? String ?? "cmd+c"]]]
    var replies = [DriverObject]()
    for call in calls {
        events = []; menuPresses = 0
        let request = try fixtureRequest(call["method"] as! String, args: call["args"] as! [Any], read: config["fallback"] as? Bool == true)
        let out = execute(request, core: core, register: false) {
            var result = try keyboard.handle(request, core: core)
            if config["fallback"] as? Bool == true {
                result.merge(["settled": true, "reason": "quiet", "truncated": false, "text": core.maps["7"]!.text!]) { _, new in new }
                result = try keyboard.completeObservation(request, core: core, observed: result)
            }
            return result
        }
        var row = out; row["events"] = events; row["menuPresses"] = menuPresses; row["layoutReads"] = layoutReads; replies.append(row)
        if config["writeBetweenCalls"] as? Bool == true { board += 1 }
    }
    return ["replies": replies]
}
if CommandLine.arguments.dropFirst().first == "--watchdog" {
    let core = try! fixtureCore(["AXRole": "AXButton", "AXTitle": "Neutral"])
    var reads = 0
    let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64), clipboardCount: {
        reads += 1
        if reads == 2 { Thread.sleep(forTimeInterval: 2) }
        return 10
    })
    runtime.register(method: "click") { request, _ in
        try request.admitInput(); return ["delivery": "sent-unverified", "retry": "read-first"]
    }
    runtime.serve()
}
while let line = readLine() {
    do {
        let result = try fixtureRun(DriverJSON.decode(Data(line.utf8)))
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    } catch { print(String(data: try! JSONSerialization.data(withJSONObject: ["fixtureError": fixtureFault(error)]), encoding: .utf8)!) }
}
