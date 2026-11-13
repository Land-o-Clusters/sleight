// Headless core fixture. AX, session, person, pointer and settle providers are
// in memory. No production entry point, capture backend or event sink runs.
let data = try DriverJSON.decode(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let trees = NSMutableDictionary(dictionary: data["trees"] as! DriverObject)
var fixture = data; fixture["trees"] = trees
let core = DriverCore(fixture: fixture)
let nonce = ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!
let runtime = DriverRuntime(core: core, nonce: nonce)
final class TimingSink: DriverPointerSink, DriverPointerPrepared {
    let changed: () -> Void
    init(_ changed: @escaping () -> Void) { self.changed = changed }
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws { if index == 1 { changed() } }
    func release(_ index: Int) throws {}
}
var clicks = 0, changing = false
let sink = TimingSink {
    clicks += 1
    guard changing else { return }
    var tree = trees["7"] as! DriverObject
    var children = tree["children"] as! [DriverObject]
    children[0]["AXValue"] = String(clicks)
    tree["children"] = children; trees["7"] = tree
}
runtime.register(method: "ping") { _, _ in
    ["protocol": driverProtocol, "platform": "darwin", "apiVersion": driverAPIVersion,
     "build": driverBuild, "methods": runtime.methods]
}
runtime.register(method: "resolveApp") { request, core in
    try core.inventory.resolve(request.params["selector"]!, launch: false, request: request)
}
runtime.register(method: "verifyWindowIdentity") { request, core in
    ["window": try core.boundWindow(request.params, request: request).window]
}
runtime.register(method: "getAXState") { request, core in
    try core.readTree(request.params, request: request)
}
runtime.register(method: "fixtureStats") { _, _ in ["clicks": clicks] }
runtime.register(method: "fixtureEnableChanges") { _, _ in changing = true; return [:] }
runtime.register(method: "rendererRestore") { request, _ in
    let args = request.params["args"] as! [DriverObject]
    let lease = args[0]["lease"] as! DriverObject
    return ["restored": true, "token": lease["token"]!]
}
runtime.registerSettleAndPerson()
// Use the real settle algorithm and tree, replacing only observer, waits,
// capture and inventory providers. The capture closure must never run.
runtime.register(method: "settle") { request, core in
    let bound = try core.boundWindow(request.params, request: request)
    let baseline = core.maps["7"]!.settleTree
    return try DriverSettle.run(DriverSettleOptions(request.params), baseline: baseline,
        inputAdmitted: request.inputAdmitted, providers: DriverSettleProviders(
            now: { ProcessInfo.processInfo.systemUptime * 1000 },
            wait: { Thread.sleep(forTimeInterval: $0 / 1000) },
            check: { try request.check() }, person: { nil },
            observe: { _ in {} },
            tree: { try DriverSettleTree.read(bound.root, request: request, includeScroll: false) },
            capture: { throw DriverFault("SCREEN_RECORDING_REQUIRED") },
            primaryWindow: { nil }, drain: {}))
}
runtime.registerRuntimeInputs(pointerSink: sink)
DispatchQueue.global().async { runtime.serve() }
RunLoop.main.run()
