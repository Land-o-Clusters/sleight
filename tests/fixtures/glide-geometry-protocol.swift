// Only synthetic windows and retained fake objects reach this reader fixture.
let nonce = String(repeating: "f", count: 64)
let frame: DriverObject = ["x": -200.0, "y": 100.0, "width": 800.0, "height": 600.0]
let child: DriverObject = ["AXRole": "AXButton", "AXTitle": "same", "AXIdentifier": "same", "key": "held", "pid": 42,
    "frame": ["x": -180.0, "y": 120.0, "width": 40.0, "height": 20.0]]
let tree: DriverObject = ["AXRole": "AXWindow", "AXTitle": "Fixture", "AXMinimized": false, "AXFullScreen": false,
    "key": "root", "pid": 42, "frame": frame, "children": [child]]
let windows: [DriverObject] = (7...23).map { id in
    ["pid": 42, "windowId": String(id), "processStart": "start", "onScreen": true,
     "hidden": false, "minimized": false, "bounds": frame, "app": "Fixture", "title": "Fixture", "layer": 0]
}
let fixture: DriverObject = ["apps": [], "windows": windows, "trees": Dictionary(uniqueKeysWithValues: (7...23).map { (String($0), tree) })]
let c = DriverCore(fixture: fixture)
c.observeRead = { _ in DriverReadObservation(sample: { 0 }, geometryCoverage: true) }
let runtime = DriverRuntime(core: c, nonce: nonce)
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
for method in ["click", "drag"] {
    runtime.register(method: method) { request, core in
        var target = request.params; target["target"] = 1
        _ = try core.resolveElement(target, request: request)
        return ["held": core.geometry.held.count]
    }
}
runtime.register(method: "health") { _, core in
    ["held": core.geometry.held.count, "turn": core.geometry.turn as Any? ?? NSNull(), "failed": core.geometry.failed]
}
runtime.serve()
