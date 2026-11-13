// App-free native bank fixtures. The only objects are the driver's fake provider.
let bounds = CGRect(x: -200, y: 100, width: 800, height: 600)
let window: DriverObject = ["pid": 42, "windowId": "7", "processStart": "start", "onScreen": true,
    "hidden": false, "minimized": false, "bounds": ["x": -200.0, "y": 100.0, "width": 800.0, "height": 600.0]]
let root = DriverNode(fake: ["key": "root"], path: "root")
let node = DriverNode(fake: ["key": "held"], path: "held")
let digest = String(repeating: "a", count: 64)
func element(_ node: DriverNode, _ root: DriverNode, _ number: Int = 1,
             _ semantic: String = "original", _ frame: CGRect = CGRect(x: -210.2, y: 120.2, width: 50.4, height: 20.3)) -> DriverElement {
    DriverElement(number: number, node: node, role: "AXButton", identifier: "same", label: "same", secure: false,
        root: root, secondary: [:], frame: frame, coordinateIdentity: ["identity": semantic])
}
func map(_ held: DriverElement?, root: DriverNode = root, start: String = "start", truncated: Bool = false,
         notifications: Bool = true) -> DriverReadMap {
    let top = DriverElement(number: 0, node: root, role: "AXWindow", identifier: "", label: "", secure: false,
        root: root, secondary: [:], frame: bounds)
    var elements = [0: top]
    if let held = held { elements[held.number] = held }
    return DriverReadMap(id: 1, processStart: start, root: root, elements: elements, truncated: truncated,
        geometry: DriverGeometryRead(start: 10, end: 11, before: 0, after: 0, initial: digest, rendered: digest,
            final: digest, notifications: notifications, settled: true))
}
func bank() -> DriverGeometryBank {
    let bank = DriverGeometryBank(pipe: DriverGeometryPipe(descriptor: -1, nonce: ""))
    bank.begin(String(repeating: "b", count: 32)); return bank
}
func emit(_ name: String, _ value: DriverObject) {
    var value = value; value["case"] = name
    print(String(decoding: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self))
}
let held = element(node, root)
let positive = bank()
emit("baseline", positive.observation(map: map(nil), window: window, request: 1, reused: false))
positive.retain(held, window: window, action: 2)
// Ordinals are deliberately different; only the held proxy can join.
emit("positive", positive.observation(map: map(element(node, root, 900)), window: window, request: 3, reused: false))
for (name, next) in [
    ("proxy", map(element(DriverNode(fake: ["key": "replacement"], path: "held"), root))),
    ("root", map(element(node, DriverNode(fake: ["key": "new-root"], path: "root")), root: DriverNode(fake: ["key": "new-root"], path: "root"))),
    ("process", map(held, start: "reused-pid")),
    ("missing", map(nil)), ("partial", map(held, truncated: true)),
    ("recycled", map(element(node, root, 1, "recycled"))), ("notifications", map(held, notifications: false))
] {
    let b = bank(); b.retain(held, window: window, action: 2)
    emit(name, b.observation(map: next, window: window, request: 3, reused: false))
}
let departed = bank(); departed.retain(held, window: window, action: 2)
emit("departed", departed.observation(map: map(element(node, root, 1, "original", CGRect(x: 1000, y: 100, width: 20, height: 20))), window: window, request: 3, reused: false))
let eviction = bank(); eviction.retain(held, window: window, action: 2); eviction.evict("7")
emit("eviction", eviction.observation(map: map(held), window: window, request: 3, reused: false))
let capacity = bank()
for id in 1...513 { capacity.retain(held, window: window, action: id) }
emit("capacity", ["held": capacity.held.count, "failed": capacity.failed])
capacity.end(String(repeating: "b", count: 32)); capacity.begin(String(repeating: "c", count: 32))
emit("next-turn", ["held": capacity.held.count, "failed": capacity.failed])
// Counting hooks replace every AX/capture/input entry in the composed source.
// They cover only the adapter calls above, with no backend work available.
emit("instrumentation", ["ax": gp2AX, "captures": gp2Captures, "inputWaits": gp2Waits])
let timing = bank(); timing.retain(held, window: window, action: 2)
let beforeCPU = clock(), began = ProcessInfo.processInfo.systemUptime
var encodedBytes = 0
for _ in 0..<1000 {
    var record = timing.observation(map: map(held), window: window, request: 3, reused: false)
    record["protocol"] = "sleight.glide-geometry/1"; record["nonce"] = String(repeating: "f", count: 64)
    var bytes = try! JSONSerialization.data(withJSONObject: record); bytes.append(10); encodedBytes = bytes.count
}
emit("overhead", ["iterations": 1000, "cpuMs": Double(clock() - beforeCPU) * 1000 / Double(CLOCKS_PER_SEC),
    "elapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000, "encodedBytes": encodedBytes])

// Completed production read taps. Reuse keeps the immutable read's interval.
let frameData: DriverObject = ["x": -200.0, "y": 100.0, "width": 800.0, "height": 600.0]
let childData: DriverObject = ["AXRole": "AXButton", "AXTitle": "same", "AXIdentifier": "same", "key": "held", "pid": 42,
    "frame": ["x": -180.0, "y": 120.0, "width": 40.0, "height": 20.0]]
let rootData: DriverObject = ["AXRole": "AXWindow", "AXTitle": "Fixture", "AXMinimized": false, "AXFullScreen": false,
    "key": "root", "pid": 42, "frame": frameData, "children": [childData]]
var readWindow = window; readWindow["app"] = "Fixture"; readWindow["title"] = "Fixture"; readWindow["layer"] = 0
let fixture: DriverObject = ["apps": [], "windows": [readWindow], "trees": ["7": rootData]]
let core = DriverCore(fixture: fixture)
core.observeRead = { _ in DriverReadObservation(sample: { 0 }, geometryCoverage: true) }
let binding: DriverObject = ["windowId": "7", "processStart": "start", "reuseIfUnchanged": 0]
func request(_ id: Int, _ params: DriverObject) -> DriverRequest {
    try! DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": String(repeating: "a", count: 64),
        "id": id, "method": "getAXState", "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000],
        nonce: String(repeating: "a", count: 64), previous: id - 1)
}
core.geometry.begin(String(repeating: "b", count: 32))
let first = try! core.readTree(binding, request: request(1, binding))
let original = core.maps["7"]!
emit("read-tap", core.geometry.observation(map: original, window: readWindow, request: 1, reused: false))
var nextBinding = binding; nextBinding["reuseIfUnchanged"] = first["readId"]
let next = try! core.readTree(nextBinding, request: request(2, nextBinding))
let nextMap = core.maps["7"]!
emit("read-reuse", ["reused": next["reused"]!, "originalStart": original.geometry!.start,
    "originalEnd": original.geometry!.end, "start": nextMap.geometry!.start, "end": nextMap.geometry!.end,
    "notifications": nextMap.geometry!.notifications, "settled": nextMap.geometry!.settled])

core.geometry.retain(original.elements[1]!, window: readWindow, action: 2)
let fresh = try! core.readTree(binding, request: request(3, binding))
emit("fresh-map", core.geometry.observation(map: core.maps["7"]!, window: readWindow, request: 3, reused: false))

// Exercise resolveElement's production retention tap. This resolves fake objects
// and never calls a pointer, key or AX input method.
func actionRequest(_ id: Int, _ method: String, _ params: DriverObject) -> DriverRequest {
    try! DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": String(repeating: "a", count: 64),
        "id": id, "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000],
        nonce: String(repeating: "a", count: 64), previous: id - 1)
}
var targetBinding = binding; targetBinding["readId"] = fresh["readId"]; targetBinding["target"] = 1
_ = try! core.resolveElement(targetBinding, request: actionRequest(4, "click", targetBinding))
let resolved = core.geometry.observation(map: core.maps["7"]!, window: readWindow, request: 5, reused: false)
emit("resolve-tap", resolved)
_ = try! core.resolveElement(targetBinding, request: actionRequest(6, "drag", targetBinding))
emit("drag-tap", core.geometry.observation(map: core.maps["7"]!, window: readWindow, request: 7, reused: false))
let rootContinuity = bank()
_ = rootContinuity.observation(map: map(nil), window: window, request: 1, reused: false)
let otherRoot = DriverNode(fake: ["key": "new-root"], path: "root")
emit("window-root-change", rootContinuity.observation(map: map(nil, root: otherRoot), window: window, request: 2, reused: false))
let duplicateBank = bank(); duplicateBank.retain(held, window: window, action: 2)
let duplicateMap = DriverReadMap(id: 2, processStart: "start", root: root,
    elements: [0: map(nil).elements[0]!, 1: held, 2: element(node, root, 2)], truncated: false, geometry: map(nil).geometry)
emit("duplicate-join", duplicateBank.observation(map: duplicateMap, window: window, request: 3, reused: false))

// Compare the entire completed-read/resolve/reuse path with collection off and
// on. The AX entry counters include the existing fake-provider read work.
func measuredTaps(_ collecting: Bool) -> DriverObject {
    let c = DriverCore(fixture: fixture)
    c.observeRead = { _ in DriverReadObservation(sample: { 0 }, geometryCoverage: true) }
    if collecting { c.geometry.begin(String(repeating: "d", count: 32)) }
    gp2AX = 0; gp2Captures = 0; gp2Waits = 0
    let first = try! c.readTree(binding, request: request(1, binding))
    var target = binding; target["readId"] = first["readId"]; target["target"] = 1
    _ = try! c.resolveElement(target, request: actionRequest(2, "click", target))
    var reused = binding; reused["reuseIfUnchanged"] = first["readId"]
    _ = try! c.readTree(reused, request: request(3, reused))
    _ = try! c.readTree(binding, request: request(4, binding))
    return ["ax": gp2AX, "captures": gp2Captures, "inputWaits": gp2Waits]
}
let tapsOff = measuredTaps(false), tapsOn = measuredTaps(true)
emit("tap-instrumentation", ["off": tapsOff, "on": tapsOn,
    "addedAX": (tapsOn["ax"] as! Int) - (tapsOff["ax"] as! Int)])

// Prebuild realistic maps outside the timing interval. The measured work is
// identity indexing, conservative geometry, complete inventories and encoding.
for count in [500, 3000] {
    var elements = map(nil).elements
    for i in 1..<count {
        elements[i] = element(DriverNode(fake: ["key": "node-\(i)"], path: "node-\(i)"), root, i,
            "semantic-\(i)", CGRect(x: -180 + i % 500, y: 120 + i % 400, width: 20, height: 20))
    }
    let full = DriverReadMap(id: 1, processStart: "start", root: root, elements: elements,
        truncated: false, geometry: map(nil).geometry)
    for references in [0, 64] {
        let b = bank()
        if references > 0 { for i in 1...references { b.retain(elements[i]!, window: window, action: i) } }
        let cpu = clock(), began = ProcessInfo.processInfo.systemUptime
        var bytes = 0
        for _ in 0..<100 {
            let record = b.observation(map: full, window: window, request: 100, reused: false)
            bytes = try! JSONSerialization.data(withJSONObject: record).count
        }
        emit("cost-\(count)-\(references)", ["elements": count, "references": references, "iterations": 100,
            "cpuMs": Double(clock() - cpu) * 1000 / Double(CLOCKS_PER_SEC),
            "elapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000, "encodedBytes": bytes])
    }
}
