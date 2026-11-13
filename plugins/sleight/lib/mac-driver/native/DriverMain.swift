import Foundation

// Each input lane supplies an inert extension method and adds its registrar here
// at integration. No static initializer reaches the desktop.
let driverRegistrars: [(DriverRuntime) -> Void] = [{ $0.registerCapture() }, { $0.registerSettleAndPerson() }, { $0.registerRenderer() },
    { $0.registerRuntimeInputs() }]

func driverMain() {
    driverRestoreRendererMain()
    let args = Array(CommandLine.arguments.dropFirst())
    var fixture: DriverObject?
    #if SLEIGHT_DRIVER_FIXTURES
    if args.count == 2 && args[0] == "--fixture" {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: args[1])), data.count <= driverLineLimit,
              let object = try? DriverJSON.decode(data) else { _exit(64) }
        fixture = object
    } else if !args.isEmpty { _exit(64) }
    #else
    if !args.isEmpty { _exit(64) }
    #endif
    guard let nonce = ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"], nonce.count == 64,
          nonce.allSatisfy({ "0123456789abcdef".contains($0) }) else { _exit(64) }
    let core = DriverCore(fixture: fixture), runtime = DriverRuntime(core: core, nonce: nonce)
    // Old records are recovery assets only. Inventory cannot acquire a board.
    let retainedClipboardRecords = fixture == nil ? (try? DriverLegacyClipboardInventory.system.scan()) : nil
    driverSemanticAdapter = DriverSemantic.startup(fixture: fixture)
    runtime.onEOF = { driverSemanticAdapter?.shutdown() }
    runtime.register(method: "ping") { request, _ in
        try request.keys([])
        return ["protocol": driverProtocol, "apiVersion": driverAPIVersion, "build": driverBuild,
                "platform": "darwin", "healthy": true, "methods": runtime.methods]
    }
    runtime.register(method: "health") { request, core in
        try request.keys([]); var result = core.health(); result["methods"] = runtime.methods
        if let count = retainedClipboardRecords { result["retainedClipboardRecords"] = count }
        return result
    }
    for method in ["getState", "listApps", "listWindows"] {
        runtime.register(method: method) { request, core in
            try request.keys([])
            let state = core.inventory.state()
            return method == "getState" ? state : method == "listApps" ? ["apps": state["apps"] ?? []] : ["windows": state["windows"] ?? []]
        }
    }
    runtime.register(method: "resolveApp") { request, core in
        try request.keys(["selector"], optional: ["launch"])
        if let launch = request.params["launch"], driverBoolean(launch) != false { throw DriverFault("INVALID_PARAMS") }
        return try core.policyWindows(core.inventory.resolve(request.params["selector"]!, launch: false, request: request), request: request)
    }
    runtime.register(method: "getApp") { request, core in
        try request.keys(["selector"], optional: ["launch"])
        guard request.params["launch"] == nil || driverBoolean(request.params["launch"]) != nil else { throw DriverFault("INVALID_PARAMS") }
        let resolved = try core.inventory.resolve(request.params["selector"]!, launch: driverBoolean(request.params["launch"]) ?? true, request: request)
        var selected: DriverBoundWindow?
        let window = try core.inventory.firstWindow(resolved, request: request) { window in
            let binding: DriverObject = ["windowId": window["windowId"]!, "processStart": window["processStart"]!]
            let bound = try core.boundWindow(binding, request: request, known: window)
            let attrs = try bound.root.attributes([kAXRoleAttribute, kAXSubroleAttribute], request: request)
            guard attrs[kAXRoleAttribute] as? String == "AXWindow",
                  ["", "AXStandardWindow"].contains(attrs[kAXSubroleAttribute] as? String ?? "") else { return false }
            selected = bound; return true
        }
        return try core.readDocumentTree(["windowId": window["windowId"]!, "processStart": window["processStart"]!], request: request, known: selected)
    }
    runtime.register(method: "getAXState") { request, core in
        try request.keys(["windowId", "processStart"], optional: ["depth", "budgetMs", "reuseIfUnchanged", "menuRequests"])
        return try core.readDocumentTree(request.params, request: request)
    }
    runtime.register(method: "verifyWindowIdentity") { request, core in
        try request.keys(["windowId", "processStart"])
        return ["window": try core.boundWindow(request.params, request: request).window]
    }
    runtime.register(method: "resolveElement") { request, core in
        try request.keys(["windowId", "processStart", "readId", "target"])
        let element = try core.resolveElement(request.params, request: request)
        let frame = try element.node.frame(request)
        return ["window": try core.boundWindow(request.params, request: request).window, "readId": request.params["readId"]!,
                "element": ["number": element.number, "role": driverRoleName(element.role),
                            "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]]]
    }
    runtime.install(driverRegistrars)
    DispatchQueue.global().async { runtime.serve() }
    RunLoop.main.run()
}

driverMain()
