// Inert core boundary for keyboard mutation checks. The normal Unicode test
// still uses macDriverSource and the real protocol, core, inventory and maps.
let driverProtocol = "sleight.driver/1"
struct DriverJSON {
    static func decode(_ data: Data) throws -> DriverObject {
        try JSONSerialization.jsonObject(with: data) as! DriverObject
    }
}
final class DriverRequest {
    let params: DriverObject
    let method: String
    let deadline: Double
    var inputAdmitted = false
    let actionEvent: TextFixtureActionEvent? = nil
    init(_ value: DriverObject, nonce: String, previous: Int) throws {
        params = value["params"] as? DriverObject ?? [:]
        method = value["method"] as? String ?? ""
        deadline = ProcessInfo.processInfo.systemUptime + 30
    }
    var remaining: Double { max(0, deadline - ProcessInfo.processInfo.systemUptime) }
    func check() throws { if remaining <= 0 { throw DriverFault("DEADLINE_EXCEEDED") } }
    func admitInput() throws { inputAdmitted = true }
    func keys(_ required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(params.keys)), Set(params.keys).isSubset(of: required.union(optional)) else { throw DriverFault("INVALID_PARAMS") }
    }
}
final class TextFixtureActionEvent { func prepare(window: DriverObject) {} }
struct TextFixtureRoot { func same(_ other: TextFixtureRoot) -> Bool { true } }
struct TextFixtureRead {
    let id = 1
    let processStart = "start"
    let root = TextFixtureRoot()
    let text: String? = "tree"
    let truncated = false
}
struct DriverBoundWindow { let window: DriverObject; let root = TextFixtureRoot() }
final class TextFixtureInventory {
    let fixture: DriverObject?
    init(_ fixture: DriverObject?) { self.fixture = fixture }
    func bound(_ params: DriverObject) throws -> DriverObject {
        guard params["windowId"] as? String == "7", params["processStart"] as? String == "start" else { throw DriverFault("IDENTITY_CHANGED") }
        return ["windowId": "7", "processStart": "start", "pid": 42]
    }
}
final class DriverCore {
    let inventory: TextFixtureInventory
    var maps = ["7": TextFixtureRead()]
    init(fixture: DriverObject?) { inventory = TextFixtureInventory(fixture) }
    func boundWindow(_ params: DriverObject, request: DriverRequest) throws -> DriverBoundWindow {
        DriverBoundWindow(window: try inventory.bound(params))
    }
    func readTree(_ params: DriverObject, request: DriverRequest) throws -> DriverObject { [:] }
}
final class DriverRuntime {
    func registerAction(method: String, handler: @escaping (DriverRequest, DriverCore) throws -> DriverObject,
                        afterObservation: ((DriverRequest, DriverCore, DriverObject) throws -> DriverObject)? = nil) {}
}
