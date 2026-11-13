// Offline only. Fake inventory mutation models AX changes after inert input.
var data = try DriverJSON.decode(Data(readLine()!.utf8))
let control = data["control"] as? DriverObject ?? [:]
var sequence: UInt64 = 0, guards = 0, presses = [String]()
let core = DriverCore(fixture: data, personProviders: DriverPersonProviders(sample: {
    DriverPersonSample(at: 100, hidIdle: 10, frontmostPID: 99, pointerPID: nil)
}, inputSequence: { sequence }))
let runtime = DriverRuntime(core: core, nonce: String(repeating: "a", count: 64))
func openPopup() {
    var fixture = core.inventory.fixture!, trees = fixture["trees"] as! DriverObject, root = trees["7"] as! DriverObject
    var children = root["children"] as! [DriverObject]
    var owner = children[0]
    owner["children"] = [data["popup"] as! DriverObject]
    children[0] = owner; root["children"] = children; trees["7"] = root; fixture["trees"] = trees
    core.inventory.fixture = fixture
}
func parent(_ node: DriverNode) -> DriverNode? {
    if node.fake?["AXTitle"] as? String == "Mode", control["barChain"] as? Bool == true {
        return DriverNode(fake: ["AXRole": "AXMenuBar"], path: "7/bar")
    }
    if node.fake?["AXRole"] as? String == "AXMenu", control["wrongChain"] as? Bool == true {
        return DriverNode(fake: ["AXRole": "AXButton"], path: "other-window/owner")
    }
    if node.fake?["AXRole"] as? String == "AXMenu", control["lateChain"] as? Bool == true && guards >= 2 { return nil }
    guard let slash = node.path.lastIndex(of: "/") else { return nil }
    let path = String(node.path[..<slash])
    return core.maps["7"]?.elements.values.first(where: { $0.node.path == path })?.node
}
final class PopupSink: DriverPointerSink, DriverPointerPrepared {
    var posts = 0
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws {
        posts += 1
        if control["delayedOpen"] as? Bool != true { openPopup() }
        if control["personDuringInput"] as? Bool == true { sequence += 1 }
    }
    func release(_ index: Int) throws {}
}
let sink = PopupSink()
let semantic = DriverSemantic(access: DriverSemanticAccess(attributes: { node, names, request in
    var attrs = try node.attributes(names, request: request)
    if node.fake?["AXTitle"] as? String == "Scientific", guards >= 2, control["lateText"] as? Bool == true { attrs["AXHelp"] = "changed" }
    return attrs
}, isSettable: { _, _, _ in false }, set: { _, _, _, _ in throw DriverFault("DRIVER_INTERNAL") },
 actionNames: { node, _ in
    if control["noSiblingActions"] as? Bool == true, node.fake?["AXTitle"] as? String != "Scientific" { throw DriverFault("AX_UNAVAILABLE") }
    return node.fake?["actions"] as? [String] ?? []
 },
 secondaryActions: { try $0.secondaryActions($1) }, perform: { node, _, _ in presses.append(node.fake?["AXTitle"] as? String ?? "") },
 parent: { node, _ in parent(node) }, children: { node, request in
    var children = try node.children(request, limit: 256).0
    if node.fake?["privateSubmenu"] as? Bool == true, control["lateHiddenCount"] as? Bool == true && guards >= 2 {
        children.append(DriverNode(fake: ["AXRole": "AXMenuItem", "AXTitle": "Extra private item"], path: node.path + "/extra"))
    }
    return children
 }, focused: { _, _ in nil }),
 beforeInput: { _, _ in guards += 1 })
runtime.register(method: "settle") { _, _ in ["settled": true, "reason": "quiet"] }
runtime.registerRuntimeInputs(pointerSink: sink, geometry: { _ in
    DriverPointerGeometry(bounds: CGRect(x: 0, y: 0, width: 100, height: 100), pixelWidth: 100, pixelHeight: 100)
}, semantic: semantic, coordinateHitTest: { _ in
    guard let map = core.maps["7"], let element = map.elements.values.first(where: { $0.identifier == "Mode" }), var fake = element.node.fake else { return nil }
    fake["AXParent"] = ["AXRole": "AXWindow", "pid": 42]
    return DriverNode(fake: fake, path: element.node.path)
})
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
var previous = 0
while let line = readLine() {
    var raw = try DriverJSON.decode(Data(line.utf8))
    if raw["fixtureOpen"] as? Bool == true { openPopup() }; raw.removeValue(forKey: "fixtureOpen")
    if raw["personInput"] as? Bool == true { sequence += 1 }; raw.removeValue(forKey: "personInput")
    if raw["replaceMenu"] as? Bool == true {
        var popup = data["popup"] as! DriverObject; popup["key"] = "replacement-menu"; data["popup"] = popup; openPopup()
    }; raw.removeValue(forKey: "replaceMenu")
    if raw["rename"] as? Bool == true {
        var popup = data["popup"] as! DriverObject, items = popup["children"] as! [DriverObject]
        items[1]["AXTitle"] = "Renamed"; popup["children"] = items; data["popup"] = popup; openPopup()
    }; raw.removeValue(forKey: "rename")
    if raw["method"] as? String == "click", var params = raw["params"] as? DriverObject {
        guards = 0
        if let args = params["args"] as? [Any], args.first is [Any], let map = core.maps["7"] {
            core.coordinateMaps[map.id] = map; params["coordinateReadId"] = map.id
        }
        params["personToken"] = try core.person.state(window: core.inventory.bound(params))["token"]
        raw["params"] = params
        if control["forceCollapsed"] as? Bool == true, var map = core.maps["7"] {
            map.text = map.text?.replacingOccurrences(of: "menu (expanded)", with: "menu (collapsed)")
            core.maps["7"] = map
        }
    }
    let request = try DriverRequest(raw, nonce: String(repeating: "a", count: 64), previous: previous); previous = request.id
    var result: DriverObject
    do { result = runtime.replyEnvelope(request, result: try runtime.handle(request)) }
    catch let fault as DriverFault { result = runtime.replyEnvelope(request, error: fault) }
    catch { result = runtime.replyEnvelope(request, error: DriverFault("DRIVER_INTERNAL")) }
    result["presses"] = presses; result["posts"] = sink.posts
    result["ownRootRecord"] = false
    result["retained"] = core.maps["7"]?.elements.keys.sorted() ?? []
    if let map = core.maps["7"], let menu = map.elements.values.first(where: { $0.role == "AXMenu" && $0.root.same(map.root) }) {
        result["ownRootRecord"] = core.popups.record(menu: menu.node, window: "7", root: map.root, sequence: sequence) != nil
        result["foreignRootRecord"] = core.popups.record(menu: menu.node, window: "7",
            root: DriverNode(fake: ["AXRole": "AXWindow"], path: "other-window"), sequence: sequence) != nil
    }
    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
}
