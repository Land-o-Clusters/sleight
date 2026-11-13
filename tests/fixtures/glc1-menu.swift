// Inert menu integration: real core/maps/registrar/wrapper, fake AX and sinks.
let data = try DriverJSON.decode(Data(readLine()!.utf8))
let control = data["control"] as? DriverObject ?? [:]
let core = DriverCore(fixture: data)
let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
var presses = [String](), guards = 0
final class MenuFixtureSink: DriverPointerSink, DriverPointerPrepared {
    var posts = 0
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws { posts += 1 }
    func release(_ index: Int) throws { posts += 1 }
}
let sink = MenuFixtureSink()
func retainedParent(_ node: DriverNode) -> DriverNode? {
    guard let slash = node.path.lastIndex(of: "/") else { return nil }
    let path = String(node.path[..<slash])
    return core.maps["7"]?.elements.values.first(where: { $0.node.path == path })?.node
}
let access = DriverSemanticAccess(attributes: { node, names, request in
    var attrs = try node.attributes(names, request: request)
    if node.fake?["AXTitle"] as? String == "Basic" {
        if let label = control["changedLabel"] as? String, names.contains("AXTitle") { attrs["AXTitle"] = label }
        if control["disabled"] as? Bool == true, names.contains("AXEnabled") { attrs["AXEnabled"] = false }
    }
    return attrs
}, isSettable: { _, _, _ in false }, set: { _, _, _, _ in throw DriverFault("DRIVER_INTERNAL") },
 actionNames: { node, _ in control["noPress"] as? Bool == true ? [] : node.fake?["actions"] as? [String] ?? [] },
 secondaryActions: { try $0.secondaryActions($1) }, perform: { node, _, _ in
    presses.append(node.fake?["AXTitle"] as? String ?? "")
    if control["lostPress"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
}, parent: { node, _ in control["reparented"] as? Bool == true ? nil : retainedParent(node) },
 children: { node, request in
    var children = try node.children(request, limit: 256).0
    if control["duplicate"] as? Bool == true, children.contains(where: { $0.fake?["AXTitle"] as? String == "Basic" }) {
        children.append(DriverNode(fake: ["AXRole": "AXMenuItem", "AXTitle": "Basic"], path: node.path + "/duplicate"))
    }
    return children
}, focused: { _, _ in nil })
let semantic = DriverSemantic(access: access, beforeInput: { request, _ in
    guards += 1
    if control["stop"] as? Bool == true { throw DriverFault("USER_STOPPED") }
    if control["identity"] as? Bool == true { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=window-id") }
    if control["lateChange"] as? Bool == true && guards > 1 { throw DriverFault("STALE_ELEMENT") }
})
runtime.registerSettleAndPerson()
// Settle's pixel backend is outside this fixture. The production action wrapper
// still performs its own post-input AX read after this inert quiet receipt.
runtime.register(method: "settle") { _, _ in ["settled": true, "reason": "quiet"] }
runtime.registerRuntimeInputs(pointerSink: sink, semantic: semantic)
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
var previous = 0
while let line = readLine() {
    var raw = try DriverJSON.decode(Data(line.utf8))
    if raw["method"] as? String == "click", var params = raw["params"] as? DriverObject {
        params["personToken"] = try core.person.state(window: core.inventory.bound(params))["token"]
        raw["params"] = params
    }
    // Corrupt only the retained target, leaving every other identity witness
    // intact. Removing the tested guard must then admit the inert AXPress.
    if raw["method"] as? String == "click", let old = core.maps["7"]?.elements[4],
       control["secure"] as? Bool == true || control["wrongRoot"] as? Bool == true {
        let changed = DriverElement(number: old.number, node: old.node, role: old.role,
            identifier: old.identifier, label: old.label, secure: control["secure"] as? Bool == true,
            root: control["wrongRoot"] as? Bool == true ? DriverNode(fake: ["AXRole": "AXWindow"], path: "other") : old.root,
            secondary: old.secondary, frame: old.frame, depth: old.depth, coordinateIdentity: old.coordinateIdentity)
        let map = core.maps["7"]!
        var elements = map.elements; elements[4] = changed
        core.maps["7"] = DriverReadMap(id: map.id, processStart: map.processStart, root: map.root,
            elements: elements, text: map.text, truncated: map.truncated, windowIDs: map.windowIDs,
            settleTree: map.settleTree, reuse: map.reuse, geometry: map.geometry)
    }
    let request = try DriverRequest(raw, nonce: String(repeating: "a", count: 64), previous: previous)
    previous = request.id
    let output: DriverObject
    do { output = runtime.replyEnvelope(request, result: try runtime.handle(request)) }
    catch let fault as DriverFault { output = runtime.replyEnvelope(request, error: fault) }
    catch { output = runtime.replyEnvelope(request, error: DriverFault("DRIVER_INTERNAL")) }
    var result = output
    result["presses"] = presses; result["pointerPosts"] = sink.posts; result["guards"] = guards
    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}
