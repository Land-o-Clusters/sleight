import Foundation

// Glide's installed preview includes input. Parent registration still checks
// this helper's source build before handing input to the runtime.
let driverInputGateEnabled = true

// Primitive lanes also use local diagnostic codes. Adapt them to the shared
// wire contract rather than turning an ordinary refusal into DRIVER_PROTOCOL.
private func driverInputFault(_ json: DriverObject) -> DriverFault {
    let original = json["code"] as? String ?? "ACTION_UNSUPPORTED"
    let aliases = ["CAPTURE_GEOMETRY_REQUIRED": "CAPTURE_GEOMETRY_CHANGED", "CAPTURE_SCALE_MISMATCH": "CAPTURE_SCALE_INVALID",
        "ELEMENT_UNAVAILABLE": "STALE_ELEMENT", "POINT_OUTSIDE_WINDOW": "INVALID_PARAMS",
        "POINTER_DISPATCH_FAILED": "ACTION_UNCONFIRMED", "MODIFIER_BINDING_CHANGED": "IDENTITY_CHANGED"]
    let code = driverErrorCodes[original] != nil ? original : aliases[original] ?? "ACTION_UNSUPPORTED"
    var fault = DriverFault(code, json["message"] as? String, unhealthy: json["unhealthy"] as? Bool ?? false)
    fault.disposition = json.filter { !["code", "message", "unhealthy"].contains($0.key) }
    if original != code { fault.disposition["reason"] = original }
    if original == "MODIFIER_BINDING_CHANGED" {
        var mapped = DriverFault(code, "IDENTITY_CHANGED step=modifier-binding", unhealthy: fault.unhealthy)
        mapped.disposition = fault.disposition; fault = mapped
    }
    return fault
}

extension DriverCore {
    func keyboardIntervalGuards(_ request: DriverRequest) throws -> (check: () throws -> Void, identity: () throws -> Void) {
        // Rebind outside fake activation, once per interval. The read's exact
        // root must still be current; a new window never becomes a new baseline.
        let bound = try boundWindow(request.params, request: request)
        guard let id = request.params["windowId"] as? String, let map = maps[id],
              map.id == driverInteger(request.params["readId"]), map.root.same(bound.root) else { throw DriverFault("STALE_ELEMENT") }
        return (check: { try self.checkPersonBeforeInput(request, window: { try self.keyboardInputWindow(bound, request: request) }) },
                identity: { _ = try self.inventory.recheck(bound.window) })
    }
}

extension DriverRuntime {
    // Defaults use native sinks and DriverPerson. Offline harnesses may replace
    // sinks; screenshot geometry still comes from this registrar's capture bank.
    func registerRuntimeInputs(pointerSink: DriverPointerSink? = nil,
                               geometry: ((DriverRequest) -> DriverPointerGeometry?)? = nil,
                               keyboard: DriverKeyboard? = nil, semantic: DriverSemantic? = nil,
                               captureBackend: DriverCaptureBackend? = nil,
                               coordinateHitTest: ((CGPoint) throws -> DriverNode?)? = nil) {
        register(method: "inputGateState") { request, _ in
            try request.keys([])
            return ["enabled": driverInputGateEnabled]
        }
        registerLocalTools(readOnly: !driverInputGateEnabled)
        guard driverInputGateEnabled else { return }
        // Retain geometry only after the existing capture service has encoded
        // a successful window-only result. A failed capture cannot replace the
        // scale belonging to the last returned screenshot.
        var captures: [Int: DriverObject] = [:]
        func imageBytes(_ result: DriverObject) -> Int {
            let image = result["screenshot"] as? DriverObject
            return (image?["data"] as? String)?.utf8.count ?? 0
        }
        let capture = DriverCaptureService(backend: captureBackend ?? DriverWindowCaptureBackend())
        for method in ["getScreenshot", "getAXStateAndScreenshot"] {
            register(method: method) { request, core in
                guard core.inventory.fixture == nil || captureBackend != nil else { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
                do {
                    guard let id = request.params["windowId"] as? String else { throw DriverFault("INVALID_PARAMS") }
                    let previousMap = core.maps[id]
                    // A screenshot-only request needs its own frame-time map,
                    // while the worker's numbered read remains the earlier one.
                    defer { if method == "getScreenshot" { core.maps[id] = previousMap } }
                    try request.keys(["windowId", "processStart"], optional: method == "getScreenshot"
                        ? ["format", "scale"] : ["depth", "budgetMs", "format", "scale", "args", "menuRequests"])
                    let treeParams = request.params.filter { ["windowId", "processStart", "depth", "budgetMs", "allowLocked", "menuRequests"].contains($0.key) }
                    // Acquisition/read already retained a map. Reuse that walk
                    // as the pre-capture witness; the post-capture walk below
                    // must match it in full before coordinates become eligible.
                    if previousMap == nil { _ = try core.readTree(treeParams, request: request) }
                    guard let beforeMap = core.maps[id] else { throw DriverFault("STALE_READ") }
                    let captureParams = request.params.filter { ["windowId", "processStart", "format", "scale", "allowLocked"].contains($0.key) }
                    let clean = DriverRequest(copying: request, method: "getScreenshot", params: captureParams)
                    let image = try capture.read(request: clean, combined: false,
                        bind: { try core.boundWindow(request.params, request: request).window }, tree: { [:] })
                    var result = try core.readTree(treeParams, request: request)
                    guard let readID = driverInteger(result["readId"]), var map = core.maps[id] else { throw DriverFault("STALE_READ") }
                    // A concurrent tree/image pair can describe different UI.
                    // Bind the image only when full AX identities and frames
                    // agree on both sides of the window-only capture.
                    if !beforeMap.coordinateMatches(map) { map.truncated = true }
                    for key in ["capture", "geometry", "screenshot"] { result[key] = image[key] }
                    result["coordinateReadId"] = readID
                    captures[readID] = result
                    core.coordinateMaps[readID] = map
                    var retainedBytes = captures.values.reduce(0) { $0 + imageBytes($1) }
                    while captures.count > 16 || retainedBytes > 64 * 1024 * 1024 {
                        guard let oldest = captures.keys.min() else { break }
                        if let removed = captures.removeValue(forKey: oldest) { retainedBytes -= imageBytes(removed) }
                        core.coordinateMaps.removeValue(forKey: oldest)
                    }
                    if method == "getScreenshot" {
                        for key in ["text", "readId", "truncated", "document"] { result.removeValue(forKey: key) }
                    }
                    return result
                } catch {
                    if let id = request.params["windowId"] as? String { core.maps.removeValue(forKey: id) }
                    throw error
                }
            }
        }
        let guardInput: DriverKeyboard.Guard = { request, core in
            try core.checkPersonBeforeInput(request)
            let window = try core.inventory.bound(request.params)
            // Input may never switch Spaces, restore a minimized window, or
            // assume that missing on-Space evidence means it is visible.
            guard driverBoolean(window["onScreen"]) == true, driverBoolean(window["minimized"]) != true else {
                throw DriverFault("NO_WINDOWS_AVAILABLE", "The window is minimized or on another Space.")
            }
        }
        let keys = keyboard ?? DriverKeyboard(intervalGuards: { request, core in
            try core.keyboardIntervalGuards(request)
        }, beforeInput: guardInput)
        keys.register(in: self, fault: { driverInputFault($0.json) })
        // CB1's semantic adapter has no clipboard capability. This registrar
        // still refuses paste below until its direct text routes are qualified.
        let semantics = semantic ?? DriverSemantic(beforeInput: guardInput)
        for method in DriverSemantic.methods {
            registerAction(method: method) { request, core in
                guard method != "paste" else { throw DriverFault("ACTION_UNSUPPORTED") }
                try guardInput(request, core)
                guard core.inventory.fixture == nil || semantic != nil else { throw DriverFault("ACTION_UNSUPPORTED") }
                return try semantics.handle(request, core: core)
            }
        }
        for method in DriverPointer.methods {
            registerAction(method: method) { request, core in
                do {
                    try guardInput(request, core)
                    guard core.inventory.fixture == nil || pointerSink != nil else { throw DriverFault("ACTION_UNSUPPORTED") }
                    if let menu = try semantics.tryMenuPress(request, core: core) { return menu }
                    if let sibling = try semantics.trySiblingPress(request, core: core) { return sibling }
                    var trustedGeometry: DriverPointerGeometry?
                    let saved: DriverObject?
                    if ["click", "doubleClick", "rightClick"].contains(method) {
                        saved = driverInteger(request.params["coordinateReadId"]).flatMap { captures[$0] }
                    } else {
                        saved = captures.keys.sorted().reversed().compactMap { captures[$0] }.first {
                            ($0["window"] as? DriverObject)?["windowId"] as? String == request.params["windowId"] as? String
                        }
                    }
                    if let saved = saved, let window = saved["window"] as? DriverObject,
                       window["windowId"] as? String == request.params["windowId"] as? String,
                       window["processStart"] as? String == request.params["processStart"] as? String,
                       let fields = saved["geometry"] as? DriverObject, let target = try? DriverCaptureTarget(window),
                       let width = DriverPointer.number(fields["pixelWidth"]), let height = DriverPointer.number(fields["pixelHeight"]) {
                        let current = try core.inventory.bound(request.params)
                        if driverInteger(current["pid"]) == driverInteger(window["pid"]),
                           current["bundleId"] as? String == window["bundleId"] as? String {
                            trustedGeometry = DriverPointerGeometry(bounds: target.bounds, pixelWidth: width, pixelHeight: height)
                            if let backend = capture.backend as? DriverWindowCaptureBackend,
                               let source = saved["capture"] as? DriverObject {
                                let currentTarget = try DriverCaptureTarget(core.boundWindow(request.params, request: request).window)
                                guard currentTarget.bounds == target.bounds else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=bounds") }
                                let size = try backend.pixelSize(currentTarget, request: request)
                                guard driverInteger(source["sourcePixelWidth"]) == size.0,
                                      driverInteger(source["sourcePixelHeight"]) == size.1 else { throw DriverFault("CAPTURE_SCALE_INVALID") }
                            }
                        }
                    }
                    // An explicit harness provider can override the capture
                    // bank. Production always uses its retained image geometry.
                    if let geometry = geometry { trustedGeometry = geometry(request) }
                    let context = try DriverPointer.context(request: request, core: core, geometry: trustedGeometry,
                        checkPerson: { try guardInput(request, core) }, hitTest: coordinateHitTest, pixelCheck: { point in
                            guard let saved = saved, let baseline = saved["screenshot"] as? DriverObject,
                                  let oldGeometry = saved["geometry"] as? DriverObject,
                                  let oldCapture = saved["capture"] as? DriverObject else { return false }
                            let window = try core.boundWindow(request.params, request: request).window
                            let target = try DriverCaptureTarget(window)
                            let image = try capture.backend.capture(target, request: request)
                            // A display-scale move refuses even when point-normalized.
                            guard driverInteger(oldCapture["sourcePixelWidth"]) == image.image.width,
                                  driverInteger(oldCapture["sourcePixelHeight"]) == image.image.height else { throw DriverFault("CAPTURE_SCALE_INVALID") }
                            guard target.matches(image.target) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=capture-target") }
                            let options = DriverRequest(copying: request, method: "getScreenshot", params: [
                                "format": (baseline["mimeType"] as? String) == "image/jpeg" ? "jpeg" : "png",
                                "scale": driverInteger(oldGeometry["pixelWidth"]) == image.image.width ? "pixel" : "point"])
                            let fields = try DriverCaptureService.fields(image, request: options)
                            guard let fresh = fields["screenshot"] as? DriverObject else { return false }
                            return try DriverCaptureService.regionHash(baseline, bounds: target.bounds, point: point) ==
                                DriverCaptureService.regionHash(fresh, bounds: target.bounds, point: point)
                        })
                    return try DriverPointer.perform(method: method, args: request.params["args"] as! [Any],
                        context: context, sink: pointerSink ?? DriverPointerNativeSink())
                } catch let failure as DriverPointerFault {
                    throw driverInputFault(failure.json)
                }
            }
        }
    }
}
