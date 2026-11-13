let reuseNonce = String(repeating: "a", count: 64)
let reuseMutation = ProcessInfo.processInfo.environment["UC2_MUTANT"] ?? ""
var reuseForcePartial = false
var reuseTransientLabel = false
var reuseDeadKeys = Set<String>()
var reuseOnAttributes: (() -> Void)?
var reuseOnFrame: ((DriverRequest) -> Void)?
var reuseTrace = false
var reuseOperations: [String] = []
var reuseRegistrationTimeout = false
var reuseRequestID = 0
func reuseRequest(_ params: DriverObject) throws -> DriverRequest {
    reuseRequestID += 1
    return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": reuseNonce,
        "id": reuseRequestID, "method": "getAXState", "params": params,
        "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: reuseNonce, previous: reuseRequestID - 1)
}
let reuseFrame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
func reuseNode(_ attrs: DriverObject = [:]) -> DriverObject {
    var node: DriverObject = ["AXRole": "AXButton", "AXTitle": "OK", "frame": reuseFrame, "key": "ok", "pid": 42]
    node.merge(attrs) { _, new in new }; return node
}
func reuseCore(_ child: DriverObject = reuseNode(), menu: Bool = false) -> DriverCore {
    let root: DriverObject = ["AXRole": "AXWindow", "AXTitle": "Fixture", "frame": reuseFrame, "pid": 42,
        "key": "window", "children": [child]]
    let window: DriverObject = ["windowId": "42", "pid": 42, "processStart": "1.0", "bundleId": "test.reuse",
        "app": "Fixture", "title": "Fixture", "bounds": reuseFrame, "onScreen": true, "layer": 0]
    var sibling = window; sibling["windowId"] = "43"; sibling["pid"] = 99
    var fixture: DriverObject = ["apps": [], "windows": [NSMutableDictionary(dictionary: window), NSMutableDictionary(dictionary: sibling)],
        "trees": NSMutableDictionary(dictionary: ["42": root])]
    if menu { fixture["menu"] = NSMutableDictionary(dictionary: ["AXRole": "AXMenuBar", "pid": 42,
        "key": "menu", "frame": reuseFrame, "children": [reuseNode(["AXRole": "AXMenuBarItem", "key": "file", "AXTitle": "File"])]]) }
    return DriverCore(fixture: fixture)
}
let reuseBinding: DriverObject = ["windowId": "42", "processStart": "1.0"]
var reuseFailures = 0
func reuseCheck(_ name: String, _ pass: Bool) {
    if !pass { reuseFailures += 1 }
    let data = try! JSONSerialization.data(withJSONObject: ["name": name, "pass": pass], options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
// DEFAULT SETTLE REGRESSION BEGIN
do {
    let child = reuseNode()
    let root = DriverNode(fake: ["AXRole": "AXWindow", "AXTitle": "Fixture", "AXValue": "value",
        "AXDescription": "desc", "AXEnabled": true, "AXFocused": false, "AXElementBusy": false,
        "AXSelected": true, "frame": reuseFrame, "pid": 42, "children": [child]], path: "default")
    let request = try reuseRequest([:])
    reuseTrace = true; reuseOperations = []
    let tree = try DriverSettleTree.read(root, request: request, includeScroll: false)
    reuseTrace = false
    let identity = "attributes:AXRole,AXSubrole,AXHidden"
    let fields = "attributes:AXTitle,AXValue,AXDescription,AXEnabled,AXFocused,AXSelected,AXIdentifier,AXElementBusy,AXChildren"
    reuseCheck("default digest keys and AX read order", reuseOperations == [identity, fields, "frame", "children", identity, fields, "frame", "children"])
    // The byte stream is the pre-UC2A encoding, including absent values and
    // the frame presence marker before each node's children count.
    var expected = SHA256()
    for value in ["AXWindow", "", "0", "Fixture", "value", "desc", "1", "0", "0", "1", "0", "0", "100", "100", "1",
                  "AXButton", "", "0", "OK", "", "", "", "", "", "1", "0", "0", "100", "100", "0"] {
        expected.update(data: Data("\(value.utf8.count):\(value)".utf8))
    }
    let digest = expected.finalize().map { String(format: "%02x", $0) }.joined()
    reuseCheck("default digest bytes match pre-branch encoding", tree.complete && tree.digest == digest)
    reuseOperations = []; reuseTrace = true
    reuseOnFrame = { request in request.walkDeadline = ProcessInfo.processInfo.systemUptime - 1 }
    let limited = try DriverSettleTree.read(root, request: request, includeScroll: false)
    reuseTrace = false; reuseOnFrame = nil
    reuseCheck("default exhausted frame budget skips children without a fault",
        reuseOperations == [identity, fields, "frame"] && !limited.complete && limited.limited && !limited.faulted)
} catch { reuseCheck("default digest threw \(error)", false) }
// DEFAULT SETTLE REGRESSION END

for (name, child) in [("secure", reuseNode(["AXRole": "AXSecureTextField"])),
                      ("document", reuseNode(["AXRole": "AXTextArea"])),
                      ("foreign process", reuseNode(["pid": 99]))] {
    let root = DriverNode(fake: ["AXRole": "AXWindow", "pid": 42, "frame": reuseFrame, "children": [child]], path: "opaque")
    let tree = try! DriverSettleTree.read(root, request: reuseRequest([:]), includeScroll: true, forReuse: true)
    reuseCheck(name + " digest alone never certifies", !tree.complete)
}
do {
    let core = reuseCore(menu: true), request = try reuseRequest(reuseBinding)
    let before = try core.boundWindow(reuseBinding, request: request)
    let first = try DriverSettleTree.read(before.root, request: request, includeScroll: true, forReuse: true, menu: before.menu)
    let menu = core.inventory.fixture!["menu"] as! NSMutableDictionary
    menu["children"] = [reuseNode(["AXRole": "AXMenuBarItem", "key": "edit", "AXTitle": "Edit"])]
    let after = try core.boundWindow(reuseBinding, request: request)
    let next = try DriverSettleTree.read(after.root, request: request, includeScroll: true, forReuse: true, menu: after.menu)
    reuseCheck("menu root changes the digest", first.complete && next.complete && first.digest != next.digest)
} catch { reuseCheck("menu digest threw \(error)", false) }

// A blocked registration queue and a provider that returns after its deadline
// are separate cases. Neither fixture consults a Mac application or AX API.
do {
    let queuedDone = DispatchSemaphore(value: 0)
    let pendingQueue = DispatchQueue(label: "fixture.delayed-registration")
    let result = DriverReadObservation.register(deadline: ProcessInfo.processInfo.systemUptime + 0.01,
        enqueue: { work in pendingQueue.asyncAfter(deadline: .now() + 0.08) { work(); queuedDone.signal() } },
        create: { reuseCheck("expired queued registration never starts", false); return nil })
    reuseCheck("registration queue timeout", result.timedOut && result.observer == nil)
    reuseCheck("registration returns before queued work", queuedDone.wait(timeout: .now()) == .timedOut)
    _ = queuedDone.wait(timeout: .now() + 1)
    let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), stopped = DispatchSemaphore(value: 0)
    let queue = DispatchQueue(label: "fixture.read-registration")
    let deadline = ProcessInfo.processInfo.systemUptime + 0.02
    let late = DriverReadObservation.register(deadline: deadline, enqueue: { work in queue.async(execute: work) }, create: {
        started.signal(); release.wait()
        return DriverReadObservation(sample: { 0 }, stop: { stopped.signal() })
    })
    reuseCheck("registration provider timeout", late.timedOut && late.observer == nil)
    reuseCheck("registration provider started", started.wait(timeout: .now() + 1) == .success)
    release.signal()
    reuseCheck("late registration is cleaned without publication", stopped.wait(timeout: .now() + 1) == .success)
    let ready = DriverReadObservation.register(deadline: ProcessInfo.processInfo.systemUptime + 1,
        enqueue: { $0() }, create: { DriverReadObservation(sample: { 7 }) })
    reuseCheck("timely registration publishes observation", !ready.timedOut && ready.observer?.sample() == 7)
    let offMain = DriverReadObservation.register(deadline: ProcessInfo.processInfo.systemUptime + 1, create: {
        let value = Thread.isMainThread ? 0 : 1
        return DriverReadObservation(sample: { value })
    })
    reuseCheck("registration runs off main thread", offMain.observer?.sample() == 1)
    let completion = DriverReadRegistration()
    completion.finish(DriverReadObservation(sample: { 0 }), deadline: ProcessInfo.processInfo.systemUptime - 1)
    reuseCheck("late completion is not retained", completion.take(deadline: ProcessInfo.processInfo.systemUptime + 1).observer == nil)
} catch { reuseCheck("registration threw \(error)", false) }

do {
    let core = reuseCore()
    core.observeRead = { _ in nil }
    var params = reuseBinding; params["reuseIfUnchanged"] = 0
    // Inject the real bounded registrar through the production start seam.
    reuseRegistrationTimeout = true
    let first = try core.readTree(params, request: reuseRequest(params))
    params["reuseIfUnchanged"] = first["readId"]
    let next = try core.readTree(params, request: reuseRequest(params))
    reuseRegistrationTimeout = false
    reuseCheck("registration timeout walks and reports diagnostics",
        core.nextRead == 2 && core.maps["42"]?.reuse == nil && next["reused"] as? Bool == false &&
        (next["diagnostics"] as? DriverObject)?["readReuse"] as? String == "observer-timeout")
} catch { reuseCheck("registration fallback threw \(error)", false) }
do {
    let core = reuseCore()
    let seed = try core.readTree(reuseBinding, request: reuseRequest(reuseBinding))
    var params = reuseBinding; params["reuseIfUnchanged"] = seed["readId"]
    let next = try core.readTree(params, request: reuseRequest(params))
    reuseCheck("missing observer walks", next["reused"] as? Bool != true && next["readId"] as? Int != seed["readId"] as? Int)
    reuseCheck("full reads expose reused false", next["reused"] as? Bool == false)
} catch { reuseCheck("native rules throw: \(error)", false) }

// Every case uses the actual reader, digest, binding and retained map. Only
// AX objects, window metadata and observer delivery are supplied in memory.
func reuseScenario(_ name: String, child: DriverObject = reuseNode(), observing: Bool = true,
                   expected: Bool = false, seedTransient: Bool = false, menu: Bool = false,
                   seedNotification: Bool = false, expectedFault: String? = nil, compareText: Bool = true,
                   change: (DriverCore, @escaping () -> Void) -> Void = { _, _ in }) {
    reuseForcePartial = false; reuseDeadKeys = []; reuseOnAttributes = nil
    do {
        let core = reuseCore(child, menu: menu)
        var revision = 0
        var samples = 0, seeding = true
        core.observeRead = { _ in observing ? DriverReadObservation(sample: {
            samples += 1
            // The seed's final sample observes an event. Later samples return
            // the initial value so only the seed-end guard rejects this proof.
            return seedNotification && seeding && samples == 2 ? revision + 1 : revision
        }) : nil }
        var params = reuseBinding; params["reuseIfUnchanged"] = 0
        reuseTransientLabel = seedTransient
        let first = try core.readTree(params, request: reuseRequest(params))
        seeding = false
        reuseTransientLabel = false
        let retainedNode = core.maps["42"]?.elements[1]?.node
        let walks = core.nextRead
        change(core, { revision += 1 })
        params["reuseIfUnchanged"] = first["readId"]
        let next = try core.readTree(params, request: reuseRequest(params))
        if expectedFault != nil { reuseCheck(name, false); return }
        let reused = next["reused"] as? Bool == true
        reuseCheck(name, reused == expected)
        reuseCheck(name + " walk count", core.nextRead == walks + (expected ? 0 : 1))
        if reused {
            reuseCheck(name + " retains map and id", next["readId"] as? Int == first["readId"] as? Int &&
                core.maps["42"]?.elements[1]?.node === retainedNode)
        }
        reuseForcePartial = false; reuseOnAttributes = nil
        let oracle = try core.readTree(reuseBinding, request: reuseRequest(reuseBinding))
        if compareText { reuseCheck(name + " fresh text equality", next["text"] as? String == oracle["text"] as? String) }
    } catch let fault as DriverFault where fault.code == expectedFault { reuseCheck(name, true) }
    catch { reuseCheck(name + " threw \(error)", false) }
}
func reuseReplace(_ core: DriverCore, child: DriverObject) {
    let trees = core.inventory.fixture!["trees"] as! NSMutableDictionary
    var root = trees["42"] as! DriverObject; root["children"] = [child]; trees["42"] = root
}
reuseScenario("unchanged tree", expected: true)
reuseScenario("rendered transient cannot certify", seedTransient: true)
reuseScenario("notification at seed end", seedNotification: true)
reuseScenario("missing observer", observing: false)
reuseScenario("sheet notification", change: { _, advance in advance() })
reuseScenario("notification during digest", change: { _, advance in
    reuseOnAttributes = { reuseOnAttributes = nil; advance() }
})
reuseScenario("partial digest", change: { _, _ in reuseForcePartial = true })
reuseScenario("resize without notification", change: { core, _ in
    let windows = core.inventory.fixture!["windows"] as! [NSMutableDictionary]
    windows[0]["bounds"] = ["x": 0.0, "y": 0.0, "width": 101.0, "height": 100.0]
})
reuseScenario("app header changed", change: { core, _ in
    let windows = core.inventory.fixture!["windows"] as! [NSMutableDictionary]; windows[0]["app"] = "Renamed"
})
func reuseDuringDigest(_ work: @escaping () -> Void) {
    reuseOnAttributes = { reuseOnAttributes = nil; work() }
}
func reuseWindow(_ core: DriverCore, _ index: Int = 0) -> NSMutableDictionary {
    (core.inventory.fixture!["windows"] as! [NSMutableDictionary])[index]
}
func reuseRootKey(_ core: DriverCore, _ key: String) {
    let trees = core.inventory.fixture!["trees"] as! NSMutableDictionary
    var root = trees["42"] as! DriverObject; root["key"] = key; trees["42"] = root
}
reuseScenario("resize during digest", expectedFault: "IDENTITY_CHANGED", change: { core, _ in reuseDuringDigest {
    reuseWindow(core)["bounds"] = ["x": 0.0, "y": 0.0, "width": 101.0, "height": 100.0]
} })
reuseScenario("resize before digest", change: { core, _ in
    reuseWindow(core)["bounds"] = ["x": 0.0, "y": 0.0, "width": 101.0, "height": 100.0]
    reuseDuringDigest { reuseWindow(core)["bounds"] = reuseFrame }
})
reuseScenario("app header before digest", compareText: false, change: { core, _ in
    reuseWindow(core)["app"] = "Renamed"
    reuseDuringDigest { reuseWindow(core)["app"] = "Fixture" }
})
reuseScenario("app header during digest", compareText: false, change: { core, _ in reuseDuringDigest { reuseWindow(core)["app"] = "Renamed" } })
reuseScenario("window inventory changed", change: { core, _ in reuseWindow(core, 1)["pid"] = 42 })
reuseScenario("window inventory before digest", change: { core, _ in
    reuseWindow(core, 1)["pid"] = 42
    reuseDuringDigest { reuseWindow(core, 1)["pid"] = 99 }
})
reuseScenario("window inventory during digest", change: { core, _ in reuseDuringDigest { reuseWindow(core, 1)["pid"] = 42 } })
reuseScenario("root replaced between reads", change: { core, _ in
    reuseRootKey(core, "replacement")
    reuseDuringDigest { reuseRootKey(core, "window") }
})
reuseScenario("root replaced during digest", change: { core, _ in reuseDuringDigest { reuseRootKey(core, "replacement") } })
reuseScenario("retained truncation", change: { core, _ in core.maps["42"]?.truncated = true })
reuseScenario("retained process start changed", change: { core, _ in
    let old = core.maps["42"]!
    core.maps["42"] = DriverReadMap(id: old.id, processStart: "old", root: old.root, elements: old.elements,
        text: old.text, truncated: old.truncated, windowIDs: old.windowIDs, settleTree: old.settleTree, reuse: old.reuse)
})
for field in ["role", "frame"] {
    reuseScenario("root \(field) proof changed", change: { core, _ in
        let p = core.maps["42"]!.reuse!
        core.maps["42"]?.reuse = DriverReadReuse(observer: p.observer, revision: p.revision, digest: p.digest,
            bounds: p.bounds, rootFrame: field == "frame" ? CGRect(x: 1, y: 0, width: 100, height: 100) : p.rootFrame,
            rootRole: field == "role" ? "AXDialog" : p.rootRole, result: p.result)
    })
}
reuseScenario("menu changed between reads", menu: true, change: { core, _ in
    let menu = core.inventory.fixture!["menu"] as! NSMutableDictionary
    menu["children"] = [reuseNode(["AXRole": "AXMenuBarItem", "key": "edit", "AXTitle": "Edit"])]
})
reuseScenario("unchanged menu", expected: true, menu: true)
for (name, attrs) in [
    ("typing without notification", ["AXValue": "edited"] as DriverObject),
    ("role", ["AXRole": "AXCheckBox"]), ("title", ["AXTitle": "Changed"]),
    ("focused", ["AXFocused": true]), ("enabled", ["AXEnabled": false]),
    ("busy", ["AXElementBusy": true]), ("subrole", ["AXSubrole": "AXCloseButton"]),
    ("selected", ["AXSelected": true]), ("expanded", ["AXExpanded": true]),
    ("identifier", ["AXIdentifier": "new-id"]), ("help", ["AXHelp": "new help"]),
    ("description", ["AXDescription": "new description"]), ("details", ["AXDetails": "new details"]),
    ("placeholder", ["AXPlaceholderValue": "new placeholder"]), ("selection", ["AXSelectedText": "chosen"]),
    ("url", ["AXURL": "https://example.test"]), ("document", ["AXDocument": "file:///fixture"]),
    ("secondary actions", ["actions": ["AXRaise"]]),
    ("position", ["frame": ["x": 2.0, "y": 0.0, "width": 100.0, "height": 100.0]]),
    ("position y", ["frame": ["x": 0.0, "y": 2.0, "width": 100.0, "height": 100.0]]),
    ("size", ["frame": ["x": 0.0, "y": 0.0, "width": 99.0, "height": 100.0]]),
    ("height", ["frame": ["x": 0.0, "y": 0.0, "width": 100.0, "height": 99.0]]),
    ("inserted child", ["children": [reuseNode(["key": "extra"])]]),
] {
    reuseScenario(name, change: { core, _ in reuseReplace(core, child: reuseNode(attrs)) })
}
reuseScenario("settable", child: reuseNode(["AXRole": "AXTextField"]), change: { core, _ in
    reuseReplace(core, child: reuseNode(["AXRole": "AXTextField", "settable": true]))
})
reuseScenario("value type", child: reuseNode(["AXRole": "AXCheckBox", "AXValue": "1"]), change: { core, _ in
    reuseReplace(core, child: reuseNode(["AXRole": "AXCheckBox", "AXValue": true]))
})
reuseScenario("selectable", child: reuseNode(["AXSelected": false]), change: { core, _ in
    reuseReplace(core, child: reuseNode(["AXSelected": false, "selectable": true]))
})
reuseScenario("secure descendants never certify", child: reuseNode(["AXRole": "AXSecureTextField"]))
reuseScenario("foreign process node never certifies", child: reuseNode(["pid": 99]))
reuseScenario("document ranges never certify", child: reuseNode(["AXRole": "AXTextArea"]))
reuseScenario("digest fault", change: { core, _ in reuseReplace(core, child: reuseNode(["digestFault": "AX_UNAVAILABLE"])) })
reuseScenario("40 ms digest budget", change: { core, _ in reuseReplace(core, child: reuseNode(["digestDelayMs": 50])) })
// Repeated equal siblings produce the same flattened attribute stream. Their
// grouping differs, so the child-count field must distinguish the two trees.
let equalLeaf = reuseNode(["AXRole": "AXGroup", "AXTitle": "", "key": "equal"])
reuseScenario("child count digest", child: reuseNode(["children": [equalLeaf, equalLeaf]]), change: { core, _ in
    var parent = equalLeaf; parent["children"] = [equalLeaf]
    reuseReplace(core, child: reuseNode(["children": [parent]]))
})
reuseScenario("node limit", change: { core, _ in
    reuseReplace(core, child: reuseNode(["children": (0..<3000).map { reuseNode(["key": "\($0)"]) }]))
})
do {
    let core = reuseCore(); var revision = 0
    core.observeRead = { _ in DriverReadObservation(sample: { revision }) }
    var params = reuseBinding; params["reuseIfUnchanged"] = 0
    let first = try core.readTree(params, request: reuseRequest(params))
    params["reuseIfUnchanged"] = first["readId"]
    let next = try core.readTree(params, request: reuseRequest(params))
    reuseDeadKeys.insert("ok")
    var resolve = reuseBinding; resolve["readId"] = next["readId"]; resolve["target"] = 1
    do { _ = try core.resolveElement(resolve, request: reuseRequest(resolve)); reuseCheck("replacement stale retained object", false) }
    catch let fault as DriverFault { reuseCheck("replacement stale retained object", fault.code == "STALE_ELEMENT") }
    reuseDeadKeys = []
    params["reuseIfUnchanged"] = (first["readId"] as! Int) + 100
    let stale = try core.readTree(params, request: reuseRequest(params))
    reuseCheck("wrong read id walks", stale["reused"] as? Bool == false)
    params["processStart"] = "2.0"
    do { _ = try core.readTree(params, request: reuseRequest(params)); reuseCheck("process replacement refuses", false) }
    catch { reuseCheck("process replacement refuses", true) }
    revision += 1
} catch { reuseCheck("identity rules threw \(error)", false) }
if reuseFailures > 0 { exit(1) }
