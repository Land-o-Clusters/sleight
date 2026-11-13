// Compiled only by the offline stdin test, before the unchanged driverMain call.
// All clipboard bytes and journals stay under the test's private temporary root.
DriverSemantic.fixtureStartup = { fixture in
    let config = fixture["semantic"] as! DriverObject
    let root = URL(fileURLWithPath: config["root"] as! String)
    let state = root.appendingPathComponent("board.json")
    let retained = (try? DriverLegacyClipboardInventory(directory: root.appendingPathComponent("clipboard")).scan()) ?? -1
    let data = try! JSONSerialization.data(withJSONObject: ["count": 17,
        "items": [["public.utf8-plain-text": Data("owner".utf8).base64EncodedString()]],
        "order": [["public.utf8-plain-text"]], "writes": 0, "reads": 0, "clears": 0, "providers": 0, "factory": 0,
        "retained": retained])
    try! data.write(to: state)
    var parents = [String: DriverNode](), nodes = [String: DriverNode]()
    func collect(_ node: DriverNode, parent: DriverNode? = nil) {
        nodes[node.path] = node; parents[node.path] = parent
        for (index, raw) in (node.fake?["children"] as? [DriverObject] ?? []).enumerated() {
            collect(DriverNode(fake: raw, path: node.path + "/\(index)"), parent: node)
        }
    }
    collect(DriverNode(fake: (fixture["trees"] as! DriverObject)["7"] as! DriverObject, path: "7"))
    let access = DriverSemanticAccess(attributes: { node, names, request in try node.attributes(names, request: request) },
        isSettable: { _, _, _ in true }, set: { _, _, _, _ in fatalError("unexpected AX write") },
        actionNames: { _, _ in [] }, secondaryActions: { _, _ in [] }, perform: { _, _, _ in fatalError("unexpected AX action") },
        parent: { node, _ in parents[node.path] }, children: { _, _ in [] }, focused: { _, _ in nodes["7/0"] })
    return DriverSemantic(access: access, qualification: { _, _, path, _ in path == .unicode },
        beforeInput: { _, _ in }, sendUnicode: { _, _, _, _ in
            if config["crashAfterSend"] as? Bool == true { _exit(70) }
        })
}

func fixtureSemanticRegister(_ runtime: DriverRuntime) {
    let config = runtime.core.inventory.fixture!["semantic"] as! DriverObject
    if config["registerSemantic"] as? Bool == true { driverSemanticAdapter!.register(in: runtime) }
    if config["wrapper"] as? Bool == true {
        runtime.registerAction(method: "setValue", handler: { request, _ in
            if config["refusedWrite"] as? Bool == true { throw DriverFault("VALUE_NOT_SETTABLE") }
            try request.admitInput()
            if config["failedWrite"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
            var result: DriverObject = ["window": ["windowId": "7"], "delivery": config["delivery"] as? String ?? "sent-verified", "retry": "read-first",
                    "valueVerified": true, "text": "stale observation must not escape"]
            if config["overLimit"] as? Bool == true {
                result["delivery"] = "sent-unverified"; result["valueVerified"] = false
                result["valueReadback"] = "over-limit"; result["valueReadbackLimit"] = DriverSemantic.textLimit
                result["selectedRange"] = [0, 1]; result["matchCount"] = 1
            }
            return result
        }, afterObservation: { _, _, result in
            if config["afterObservationFails"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
            return result
        })
        runtime.register(method: "settle") { _, _ in
            if let code = config["settleFault"] as? String { throw DriverFault(code, unhealthy: config["settleUnhealthy"] as? Bool ?? false) }
            return ["settled": true]
        }
    }
}
