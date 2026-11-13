// Offline providers only. The sink refuses every posted pointer event.
let data = try DriverJSON.decode(Data(readLine()!.utf8))
let core = DriverCore(fixture: data, personProviders: DriverPersonProviders(sample: {
    DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 99, pointerPID: nil)
}, inputSequence: { 0 }))
let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
var presses = 0
let semantic = DriverSemantic(access: DriverSemanticAccess(attributes: { try $0.attributes($1, request: $2) },
    isSettable: { _, _, _ in false }, set: { _, _, _, _ in throw DriverFault("DRIVER_INTERNAL") },
    actionNames: { node, _ in node.fake?["actions"] as? [String] ?? [] }, secondaryActions: { try $0.secondaryActions($1) },
    perform: { _, _, _ in
        presses += 1
        if let after = data["after"] as? DriverObject { core.inventory.fixture = after; _ = core.inventory.state() }
    }, parent: { node, _ in
        guard let slash = node.path.lastIndex(of: "/") else { return nil }
        let path = String(node.path[..<slash])
        return core.maps["7"]?.elements.values.first(where: { $0.node.path == path })?.node
    }, children: { try $0.children($1, limit: 256).0 }, focused: { _, _ in nil }), beforeInput: { _, _ in })
final class RefusingSink: DriverPointerSink, DriverPointerPrepared {
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { throw DriverFault("DRIVER_INTERNAL") }
    func post(_ index: Int) throws { throw DriverFault("DRIVER_INTERNAL") }
    func release(_ index: Int) throws {}
}
runtime.register(method: "settle") { _, _ in
    if let code = data["settleFailure"] as? String { throw DriverFault(code) }
    return ["settled": true, "reason": "quiet"]
}
runtime.registerRuntimeInputs(pointerSink: RefusingSink(), semantic: semantic)
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
runtime.register(method: "fixtureResolve") { request, core in
    let element = try core.resolveElement(request.params, request: request)
    return ["number": element.number, "path": element.node.path]
}
var previous = 0
while let line = readLine() {
    var raw = try DriverJSON.decode(Data(line.utf8))
    if raw["method"] as? String == "click", var params = raw["params"] as? DriverObject {
        params["personToken"] = try core.person.state(window: core.inventory.bound(params))["token"]
        raw["params"] = params
    }
    let request = try DriverRequest(raw, nonce: String(repeating: "a", count: 64), previous: previous); previous = request.id
    var reply: DriverObject
    do { reply = runtime.replyEnvelope(request, result: try runtime.handle(request)) }
    catch let fault as DriverFault { reply = runtime.replyEnvelope(request, error: fault) }
    catch { reply = runtime.replyEnvelope(request, error: DriverFault("DRIVER_INTERNAL")) }
    reply["presses"] = presses
    reply["menuCacheHit"] = core.maps["7"]?.menuCache?.wasHit ?? false
    reply["paths"] = core.maps["7"]?.elements.values.sorted { $0.number < $1.number }.map { $0.node.path } ?? []
    print(String(data: try JSONSerialization.data(withJSONObject: reply), encoding: .utf8)!)
}
