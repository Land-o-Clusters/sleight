// Test entry point only. Every desktop provider uses memory fixtures.
// The production DriverMain entry point is excluded by the composing test.
final class ParityPointerSink: DriverPointerSink, DriverPointerPrepared {
    var steps = [DriverPointerStep](), events = [DriverObject]()
    var window: DriverPointerWindow?
    var beforePosts: () -> Void = {}
    var afterPost: (Int) -> Void = { _ in }
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        self.steps = steps; self.window = window
        beforePosts()
        return self
    }
    func post(_ index: Int) throws {
        let event = steps[index].event
        events.append(["pid": Int(window!.pid), "windowID": Int(window!.windowID),
            "x": event.point.x, "y": event.point.y, "type": event.type.rawValue])
        afterPost(index)
    }
    func release(_ index: Int) throws { events.append(["cleanup": true]) }
}

final class ParityCapture: DriverCaptureBackend {
    var scale = 2
    var resizedWidth = 0
    var calls = 0
    func preflight() -> Bool { true }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        calls += 1
        let width = Int(target.bounds.width) * scale, height = Int(target.bounds.height) * scale
        let pixels = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        pixels.setFillColor(CGColor(gray: 0.4, alpha: 1))
        pixels.fill(CGRect(x: 0, y: 0, width: width, height: height))
        var image = pixels.makeImage()!
        if resizedWidth > 0 {
            let shownHeight = height * resizedWidth / width
            let shown = CGContext(data: nil, width: resizedWidth, height: shownHeight, bitsPerComponent: 8,
                bytesPerRow: resizedWidth * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            shown.draw(image, in: CGRect(x: 0, y: 0, width: resizedWidth, height: shownHeight))
            image = shown.makeImage()!
        }
        return DriverCapturedImage(image: image, target: target)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 1,
      let data = try? Data(contentsOf: URL(fileURLWithPath: args[0])),
      var fixture = try? DriverJSON.decode(data),
      let nonce = ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"] else { exit(64) }
let session = NSMutableDictionary(dictionary: ["kCGSSessionOnConsoleKey": true,
    "kCGSessionLoginDoneKey": true, "CGSSessionScreenIsLocked": false])
fixture["session"] = session
var sample = DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 777, pointerPID: nil)
let core = DriverCore(fixture: fixture, personProviders: DriverPersonProviders(sample: { sample }))
let runtime = DriverRuntime(core: core, nonce: nonce), capture = ParityCapture()
var disturbance = "none", beforeAdmission = false, afterRelease = false, crashNextRead = false
var attempts = 0, posts = 0, reads = 0
var copiesSharedAdmission = false, copiesSharedWatch = false
let pointer = ParityPointerSink()

runtime.register(method: "ping") { request, _ in
    try request.keys([])
    return ["protocol": driverProtocol, "apiVersion": driverAPIVersion, "platform": "darwin",
        "build": driverBuild, "healthy": true, "methods": runtime.methods]
}
// Health is session-exempt in production. Only this test entry point accepts
// fixture controls; no control is added to the shipped driver or model API.
runtime.register(method: "health") { request, core in
    if let value = request.params["locked"] as? Bool { session["CGSSessionScreenIsLocked"] = value }
    if let value = request.params["disturbance"] as? String { disturbance = value }
    if let value = request.params["beforeAdmission"] as? Bool { beforeAdmission = value }
    if let value = request.params["afterRelease"] as? Bool { afterRelease = value }
    if request.params["targetWasFront"] as? Bool == true {
        sample = DriverPersonSample(at: sample.at, hidIdle: sample.hidIdle, frontmostPID: 321, pointerPID: nil)
    }
    if request.params["quiet"] as? Bool == true {
        sample = DriverPersonSample(at: sample.at + 20, hidIdle: sample.hidIdle + 20, frontmostPID: 777, pointerPID: nil)
    }
    if let value = request.params["scale"] as? Int { capture.scale = value }
    if let value = request.params["resizedWidth"] as? Int { capture.resizedWidth = value }
    if let value = request.params["crashNextRead"] as? Bool { crashNextRead = value }
    var result = core.health()
    result["attempts"] = attempts; result["posts"] = posts; result["reads"] = reads
    result["captures"] = capture.calls
    result["copiesSharedAdmission"] = copiesSharedAdmission; result["copiesSharedWatch"] = copiesSharedWatch
    result["pointerEvents"] = pointer.events
    return result
}
for method in ["getState", "listApps", "listWindows"] {
    runtime.register(method: method) { _, core in
        let state = core.inventory.state()
        return method == "getState" ? state : [method == "listApps" ? "apps" : "windows": state[method == "listApps" ? "apps" : "windows"]!]
    }
}
runtime.register(method: "resolveApp") { request, core in
    try core.inventory.resolve(request.params["selector"]!, launch: false, request: request)
}
// This fake-desktop parity harness keeps one plain walk per read. Validate the
// new parent envelope without enabling renderer activation or changing read IDs.
func parityReadRequest(_ request: DriverRequest) throws -> DriverRequest {
    var params = request.params
    if params["args"] != nil {
        _ = try DriverRendererWireLease(DriverRendererWireLease.envelope(params, read: true)["lease"])
        params.removeValue(forKey: "args")
    }
    return DriverRequest(copying: request, method: request.method, params: params)
}
for method in ["getApp", "getAXState"] {
    runtime.register(method: method) { request, core in
        if crashNextRead { exit(86) }
        reads += 1
        let clean = try parityReadRequest(request)
        return try core.readTree(clean.params, request: clean)
    }
}
runtime.register(method: "verifyWindowIdentity") { request, core in
    ["window": try core.boundWindow(request.params, request: request).window]
}
runtime.register(method: "resolveElement") { request, core in
    let element = try core.resolveElement(request.params, request: request)
    return ["number": element.number]
}
runtime.registerCapture(backend: capture)
// This parity fixture never enables renderer attributes. Lease-end inventory
// still uses the production service with an unavailable store and zero AX writes.
let renderer = DriverRendererService(store: nil)
runtime.register(method: "rendererRestore") { request, _ in try renderer.restore(request) }
let rendererCapture = DriverCaptureService(backend: capture)
runtime.register(method: "getAXStateAndScreenshot") { request, core in
    try renderer.read(parityReadRequest(request), core: core, capture: rendererCapture)
}
runtime.registerSettleAndPerson()

func disturb() {
    if disturbance == "front-only" {
        sample = DriverPersonSample(at: sample.at + 1, hidIdle: sample.hidIdle + 1,
            frontmostPID: 321, pointerPID: nil)
    } else if disturbance == "unrelated" || disturbance == "agent-foreground" {
        sample = DriverPersonSample(at: sample.at + 1, hidIdle: 0.01, frontmostPID: 900, pointerPID: 900)
    } else if disturbance != "none" {
        // HID samples have no human/agent identity or key/pointer event type.
        // Foreground keys and pointer activity in a covered target use the same guard.
        sample = DriverPersonSample(at: sample.at + 1, hidIdle: 0.01,
            frontmostPID: disturbance == "key" ? 321 : 900,
            pointerPID: disturbance == "key" ? nil : 321)
    }
}
runtime.register(method: "click") { request, core in
    attempts += 1
    // Create both copies before a watch or admission exists, as RT26F requires.
    var params = request.params; params.removeValue(forKey: "read")
    let posting = DriverRequest(copying: request, method: "click", params: params)
    let observing = DriverRequest(copying: request, method: "settle", params: request.params)
    try core.checkPersonBeforeInput(posting)
    pointer.beforePosts = {
        copiesSharedWatch = request.personWatch === posting.personWatch && observing.personWatch === posting.personWatch
        if beforeAdmission { disturb() }
    }
    pointer.afterPost = { index in
        posts += 1
        copiesSharedAdmission = request.inputAdmitted && observing.inputAdmitted && posting.inputAdmitted
        if !beforeAdmission && index == (afterRelease ? 1 : 0) { disturb() }
    }
    do {
        let context = try DriverPointer.context(request: posting, core: core, geometry: nil,
            checkPerson: { try core.checkPerson(posting) })
        return try DriverPointer.perform(method: "click", args: params["args"] as! [Any], context: context, sink: pointer)
    } catch let error as DriverPointerFault {
        var fault = DriverFault(error.code, error.message, unhealthy: error.unhealthy)
        fault.disposition = error.json
        throw fault
    }
}
// No run loop, NSApplication, notification subscription or window is started.
runtime.serve()
