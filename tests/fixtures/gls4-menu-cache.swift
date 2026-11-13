// Only in-memory inventory/AX and the real printer run, never driverMain.
let frame: DriverObject = ["x": 0, "y": 0, "width": 400, "height": 300]
func item(_ title: String, _ extra: DriverObject = [:]) -> DriverObject {
    var row: DriverObject = ["AXRole": "AXMenuItem", "AXTitle": title, "AXEnabled": true, "frame": frame, "pid": 42]
    row.merge(extra) { _, value in value }; return row
}
func fixture(_ items: [DriverObject]) -> DriverObject {
    ["apps": [["id": "test.fixture", "name": "Fixture", "pid": 42, "processStart": "start"]],
     "windows": [["windowId": "7", "pid": 42, "processStart": "start", "app": "Fixture", "title": "Fixture",
                  "bounds": frame, "onScreen": true, "layer": 0, "hidden": false]],
     "trees": ["7": ["AXRole": "AXWindow", "AXTitle": "Fixture", "frame": frame, "pid": 42]],
     "menu": ["AXRole": "AXMenuBar", "pid": 42, "children": [["AXRole": "AXMenuBarItem", "AXTitle": "View", "pid": 42,
        "children": [["AXRole": "AXMenu", "AXExpanded": false, "pid": 42, "children": items]]]]]]
}
let nonce = String(repeating: "a", count: 64)
var sequence = 0, failed = false
func read(_ core: DriverCore, _ options: DriverObject = [:], known: DriverBoundWindow? = nil) throws -> DriverObject {
    sequence += 1
    var params: DriverObject = ["windowId": "7", "processStart": "start"]
    params.merge(options) { _, value in value }
    let request = try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": sequence,
        "method": "getAXState", "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: 0)
    return try core.readTree(params, request: request, known: known)
}
func check(_ name: String, _ pass: Bool, count: Int = 1) {
    if !pass { failed = true }
    print(String(data: try! JSONSerialization.data(withJSONObject: ["name": name, "pass": pass, "cases": count]), encoding: .utf8)!)
}
let original = fixture([item("Basic"), item("Scientific")])
let core = DriverCore(fixture: original)
let first = try read(core), second = try read(core)
check("unchanged menu hits and is byte equal", core.maps["7"]?.menuCache?.wasHit == true && first["text"] as? String == second["text"] as? String)
let changed = fixture([item("Changed"), item("Scientific", ["AXEnabled": false])])
core.inventory.fixture = changed
let mutated = try read(core), live = try read(DriverCore(fixture: changed))
check("leaf changes behind identical bar walk", core.maps["7"]?.menuCache?.wasHit == false && mutated["text"] as? String == live["text"] as? String)
let saved = DriverCore(fixture: original)
_ = try read(saved)
let snap = saved.maps["7"]!.menuCache!.snapshot
func copySnapshot(pid: Int = 42, start: String = "start", requests: [String] = []) -> DriverMenuSnapshot {
    DriverMenuSnapshot(root: snap.root, pid: pid, processStart: start, requests: requests, nodes: snap.nodes, digest: snap.digest)
}
check("pid binds the cache", !snap.matches(copySnapshot(pid: 43)))
check("process start binds the cache", !snap.matches(copySnapshot(start: "restarted")))
check("submenu requests bind the cache", !snap.matches(copySnapshot(requests: ["Font"])))
var replaced = original, replacedMenu = replaced["menu"] as! DriverObject
var replacedBars = replacedMenu["children"] as! [DriverObject]
replacedBars[0]["key"] = "replacement"; replacedMenu["children"] = replacedBars; replaced["menu"] = replacedMenu
saved.inventory.fixture = replaced
_ = try read(saved)
check("same-text replacement walks", saved.maps["7"]?.menuCache?.wasHit == false)
func hiddenFixture(_ count: Int) -> DriverObject {
    fixture([item("Font", ["children": [["AXRole": "AXMenu", "AXExpanded": false,
        "children": (0..<count).map { item("Private \($0)") }]]])])
}
let hiddenCore = DriverCore(fixture: hiddenFixture(2))
_ = try read(hiddenCore)
hiddenCore.inventory.fixture = hiddenFixture(3)
let hiddenChanged = try read(hiddenCore), hiddenLive = try read(DriverCore(fixture: hiddenFixture(3)))
check("hidden submenu count participates", hiddenCore.maps["7"]?.menuCache?.wasHit == false && hiddenChanged["text"] as? String == hiddenLive["text"] as? String)
let aliasCore = DriverCore(fixture: original)
_ = try read(aliasCore)
let aliasMenu = aliasCore.maps["7"]!.menuCache!.snapshot.root
let aliasBound = DriverBoundWindow(window: (original["windows"] as! [DriverObject])[0], root: aliasMenu, menu: aliasMenu)
let aliasRead = try read(aliasCore, known: aliasBound)
check("cross-root aliases cannot bypass truncation", aliasRead["truncated"] as? Bool == true && aliasCore.maps["7"]?.menuCache == nil)
var allEqual = true, hits = 0
// Seeded, bounded property cases include hidden children, states, values and rows
// before the menu changing number. No private text enters test output.
var seed: UInt64 = 0x47534c34
func random(_ limit: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1; return Int((seed >> 32) % UInt64(limit)) }
for index in 0..<256 {
    var items = (0..<(2 + random(20))).map { item("Item \($0)") }
    let n = random(items.count)
    switch index % 8 {
    case 0: items[n]["AXTitle"] = "Renamed \(random(100))"
    case 1: items[n]["AXEnabled"] = false
    case 2: items[n]["AXValue"] = random(10)
    case 3: items[n]["AXSelected"] = true
    case 4: items[n]["AXDescription"] = "Description\nwith control"
    case 5: items[n]["children"] = [["AXRole": "AXMenu", "AXExpanded": false,
        "children": (0..<random(8)).map { item("Private \($0)") }]]
    case 6: items[n]["AXDetails"] = "Details 🐈"
    default: items[n]["AXFocused"] = true
    }
    let f = fixture(items), current = DriverCore(fixture: f)
    _ = try read(current)
    var next = f
    if index % 3 == 0 { next["trees"] = ["7": ["AXRole": "AXWindow", "AXTitle": "Fixture", "frame": frame, "pid": 42,
        "children": [["AXRole": "AXButton", "AXTitle": "Before", "pid": 42, "frame": frame]]]] }
    current.inventory.fixture = next
    let cached = try read(current), uncached = try read(DriverCore(fixture: next))
    if current.maps["7"]?.menuCache?.wasHit == true { hits += 1 }
    let cachedMap = current.maps["7"]!, liveCore = DriverCore(fixture: next)
    _ = try read(liveCore)
    allEqual = allEqual && cached["text"] as? String == uncached["text"] as? String &&
        cachedMap.elements.count == liveCore.maps["7"]!.elements.count && cachedMap.elements.allSatisfy { number, row in
            guard let other = liveCore.maps["7"]!.elements[number] else { return false }
            return row.number == other.number && row.role == other.role && row.depth == other.depth &&
                row.node.same(other.node) && row.coordinateIdentity == other.coordinateIdentity && row.menuIdentity == other.menuIdentity
        }
}
check("seeded cached/live tree and map equality", allEqual && hits >= 200, count: 256)
let recordings = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [DriverObject]
var recordedEqual = true, recordedCases = 0, recordedHits = 0
for recording in recordings {
    // Use the recorded menu with the deterministic fixture window, then mutate
    // one printed leaf at a time while preserving the top-level bar digest.
    guard var menu = recording["menu"] as? DriverObject else { continue }
    var initial = original; initial["menu"] = menu
    let c = DriverCore(fixture: initial)
    _ = try read(c)
    for mutation in 0..<32 {
        var f = original
        if mutation > 0, var bars = menu["children"] as? [DriverObject], bars.count > 1,
           var menus = bars[1]["children"] as? [DriverObject], !menus.isEmpty,
           var leaves = menus[0]["children"] as? [DriverObject], !leaves.isEmpty {
            leaves[0][mutation % 2 == 0 ? "AXTitle" : "AXDescription"] = "Recorded mutation \(mutation)"
            menus[0]["children"] = leaves; bars[1]["children"] = menus; menu["children"] = bars
        }
        f["menu"] = menu
        c.inventory.fixture = f
        let cached = try read(c), uncached = try read(DriverCore(fixture: f))
        if c.maps["7"]?.menuCache?.wasHit == true { recordedHits += 1 }
        recordedEqual = recordedEqual && cached["text"] as? String == uncached["text"] as? String
        recordedCases += 1
    }
}
check("recorded tree cached/live byte equality", recordedEqual && recordedCases > 0 && recordedHits > 0, count: recordedCases)
// Unsupported roles and strict AX faults must use the original walker.
for extra: DriverObject in [["AXRole": "AXSecureTextField", "AXValue": "secret"],
                           ["AXHelp": ["axError": -25204]], ["AXRole": "AXGroup"],
                           ["AXHelp": ["unsupported": "object"]],
                           ["AXSubrole": "AXSecureTextField", "AXValue": "secret", "forbidReads": ["AXValue"]]] {
    let f = fixture([item("Basic", extra)]), c = DriverCore(fixture: f)
    _ = try read(c); let row = try read(c)
    let uncached = try read(DriverCore(fixture: f))
    check("unsupported or faulted menu walks", c.maps["7"]?.menuCache?.wasHit != true && row["text"] as? String == uncached["text"] as? String)
}
check("secure values are never speculatively read", gls4ProtectedReads == 0)
let large = fixture((0..<40).map { item("Large \($0)", ["AXHelp": String(repeating: "x", count: 32768)]) })
let largeCore = DriverCore(fixture: large)
let largeRead = try read(largeCore)
check("aggregate raw attributes exceed the cache budget", largeRead["truncated"] as? Bool == false && largeCore.maps["7"]?.menuCache == nil)
var manyActions = original, actionMenu = manyActions["menu"] as! DriverObject
actionMenu["actions"] = (0..<257).map { "AXAction\($0)" }; manyActions["menu"] = actionMenu
let actionsCore = DriverCore(fixture: manyActions)
let actionsRead = try read(actionsCore)
check("secondary action count is bounded", actionsRead["truncated"] as? Bool == false && actionsCore.maps["7"]?.menuCache == nil)
func capture(_ menu: DriverObject, expired: Bool = false) throws -> DriverMenuSnapshot? {
    sequence += 1
    let request = try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": sequence,
        "method": "getAXState", "params": ["gls4Expire": expired],
        "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: 0)
    return try DriverMenuSnapshot.capture(DriverNode(fake: menu, path: "menu"),
        window: ["pid": 42, "processStart": "start"], requests: [], request: request)
}
var deep: DriverObject = ["AXRole": "AXMenu", "pid": 42]
for _ in 0..<66 { deep = ["AXRole": "AXMenu", "pid": 42, "children": [deep]] }
let deepMenu: DriverObject = ["AXRole": "AXMenuBar", "pid": 42, "children": [["AXRole": "AXMenuBarItem",
    "AXTitle": "View", "pid": 42, "children": [deep]]]]
check("capture depth is bounded", try capture(deepMenu) == nil)
let broad = fixture([item("Leaf")])["menu"] as! DriverObject
var wide = broad
wide["children"] = (0..<2).map { n in ["AXRole": "AXMenuBarItem", "AXTitle": "Bar \(n)", "pid": 42,
    "children": [["AXRole": "AXMenu", "pid": 42, "children": (0..<1500).map { item("Leaf \($0)") }]]] as DriverObject }
check("capture node count is bounded", try capture(wide) == nil)
check("completed capture past the walk deadline is rejected", try capture(["AXRole": "AXMenuBar", "pid": 42, "frame": frame], expired: true) == nil)
exit(failed ? 1 : 0)
