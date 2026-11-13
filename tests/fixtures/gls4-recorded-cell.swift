// GLS1's seven targets, retained sibling AXPress path, inert providers only.
let data = try DriverJSON.decode(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let core = DriverCore(fixture: data)
let nonce = ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!
let runtime = DriverRuntime(core: core, nonce: nonce)
var clicks = 0
func parent(_ node: DriverNode) -> DriverNode? {
    guard let slash = node.path.lastIndex(of: "/") else { return nil }
    let path = String(node.path[..<slash])
    return core.maps["7"]?.elements.values.first(where: { $0.node.path == path })?.node
}
let access = DriverSemanticAccess(attributes: { try $0.attributes($1, request: $2) },
    isSettable: { _, _, _ in false }, set: { _, _, _, _ in throw DriverFault("DRIVER_INTERNAL") },
    actionNames: { node, _ in node.fake?["actions"] as? [String] ?? [] }, secondaryActions: { try $0.secondaryActions($1) },
    perform: { _, _, _ in clicks += 1 }, parent: { node, _ in parent(node) },
    children: { try $0.children($1, limit: 256).0 }, focused: { _, _ in nil })
let semantic = DriverSemantic(access: access, beforeInput: { request, _ in try request.check() })
final class RecordedPointer: DriverPointerSink, DriverPointerPrepared {
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws { if index == 1 { clicks += 1 } }
    func release(_ index: Int) throws {}
}
runtime.register(method: "ping") { _, _ in
    ["protocol": driverProtocol, "platform": "darwin", "apiVersion": driverAPIVersion,
     "build": driverBuild, "methods": runtime.methods]
}
runtime.register(method: "resolveApp") { request, core in try core.inventory.resolve(request.params["selector"]!, launch: false, request: request) }
runtime.register(method: "verifyWindowIdentity") { request, core in ["window": try core.boundWindow(request.params, request: request).window] }
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
runtime.register(method: "fixtureStats") { _, _ in ["clicks": clicks] }
runtime.register(method: "rendererRestore") { request, _ in
    let args = request.params["args"] as! [DriverObject], lease = args[0]["lease"] as! DriverObject
    return ["restored": true, "token": lease["token"]!]
}
runtime.registerSettleAndPerson()
runtime.registerRuntimeInputs(pointerSink: RecordedPointer(), semantic: semantic)
DispatchQueue.global().async { runtime.serve() }
RunLoop.main.run()
