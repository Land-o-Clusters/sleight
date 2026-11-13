// Stdin fixtures only. This entry point never calls driverMain or creates an app.
enum NSPasteboard {
    struct Board { var changeCount: Int { fatalError("real board adapter forbidden") } }
    static var general: Board { Board() }
}
if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--wire" {
    var fixture = try DriverJSON.decode(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
    // Wire fixtures model kernel process evidence from their inventory. Direct
    // local-tool fixtures supply their own sequence to model replacement races.
    var localTools = fixture["localTools"] as? DriverObject ?? [:]
    if localTools["driverIdentities"] == nil { localTools["driverIdentities"] = fixture["windows"] ?? [] }
    fixture["localTools"] = localTools
    let runtime = DriverRuntime(core: DriverCore(fixture: fixture), nonce: ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"] ?? String(repeating: "a", count: 64), clipboardCount: { 10 })
    runtime.registerLocalTools(readOnly: false)
    runtime.register(method: "verifyWindowIdentity") { request, core in
        try request.keys(["windowId", "processStart"])
        return ["window": try core.boundWindow(request.params, request: request).window]
    }
    runtime.register(method: "health") { request, core in try request.keys([]); return core.health() }
    runtime.register(method: "ping") { request, _ in
        try request.keys([])
        return ["protocol": driverProtocol, "apiVersion": driverAPIVersion, "build": driverBuild,
            "platform": "darwin", "healthy": true, "methods": runtime.methods]
    }
    DispatchQueue.global().async { runtime.serve() }
    RunLoop.main.run()
}
let tools = DriverLocalTools()
while let line = readLine() {
    do {
        let row = try DriverJSON.decode(Data(line.utf8))
        let script = row["script"] as! String, args = row["args"] as? DriverObject ?? [:]
        let request = try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": String(repeating: "a", count: 64),
            "id": 1, "method": "localTool", "params": ["args": [script, args]],
            "deadline": Int(Date().timeIntervalSince1970 * 1000 + 30000)], nonce: String(repeating: "a", count: 64), previous: 0)
        // Nonoptional fixture ensures every native provider stays unreachable.
        let io = DriverLocalIO(request, fixture: row["fixture"] as? DriverObject ?? [:])
        var result: DriverObject
        do {
            if script == "real-click" {
                try io.realClick(DriverLocalNode(fake: ["pid": io.fixture?["clickPID"] ?? 0, "AXPosition": [100.0, 20.0], "AXSize": [30.0, 10.0]], io: io), args: args); result = ["ok": true]
            } else if script == "matching-apps" {
                result = ["count": io.matches(args["selector"] as? String ?? "", insensitive: true).count]
            } else { result = try tools.run(script, args, io) }
        } catch {
            // Expose the same script error boundary as registerLocalTools.
            if let error = error as? LocalToolError {
                result = localToolFailure(error)
                if result["accessibility"] as? Bool == false { result.removeValue(forKey: "accessibility") }
            }
            else { result = ["ok": false, "error": (error as? DriverFault)?.message ?? String(describing: error)] }
        }
        let record: DriverObject = ["result": result, "events": io.events, "elapsed": io.elapsed]
        print(localJSON(record))
    } catch { print("{\"result\":{\"ok\":false,\"error\":\"invalid fixture\"}}") }
}
