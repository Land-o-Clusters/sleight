var replayID = 0
func replayRequest(_ params: DriverObject) throws -> DriverRequest {
    replayID += 1
    let nonce = String(repeating: "a", count: 64)
    return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
        "id": replayID, "method": "getAXState", "params": params,
        "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: replayID - 1)
}
do {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let cells = try JSONSerialization.jsonObject(with: input) as! [DriverObject]
    var rows = [DriverObject]()
    for cell in cells {
        var before = cell["before"] as! DriverObject
        let after = cell["after"] as! DriverObject
        let trees = NSMutableDictionary(dictionary: before["trees"] as! DriverObject)
        before["trees"] = trees
        let menuPresenceChanged = (before["menu"] == nil) != (after["menu"] == nil)
        // A stable menu container lets the fixture swap its children like live AX.
        let menu = NSMutableDictionary(dictionary: before["menu"] as? DriverObject ?? [:])
        if menu.count > 0 { before["menu"] = menu }
        let core = DriverCore(fixture: before)
        core.observeRead = { _ in DriverReadObservation(sample: { 0 }) }
        var params: DriverObject = ["windowId": "7", "processStart": "1.2", "reuseIfUnchanged": 0]
        let seed = try core.readTree(params, request: replayRequest(params))
        if menuPresenceChanged {
            // Reconstructing a removed root requires a new fake inventory.
            // It cannot supply a reusable native map from the preceding helper.
            let changed = DriverCore(fixture: after)
            let fresh = try changed.readTree(params, request: replayRequest(params))
            let oracle = try changed.readTree(params, request: replayRequest(params))
            rows.append(["task": cell["task"] ?? "fixture", "reused": false, "walks": 2,
                "equal": fresh["text"] as? String == oracle["text"] as? String])
            continue
        }
        trees.setDictionary(after["trees"] as! DriverObject)
        if menu.count > 0 { menu.setDictionary(after["menu"] as? DriverObject ?? [:]) }
        params["reuseIfUnchanged"] = seed["readId"]
        let next = try core.readTree(params, request: replayRequest(params))
        let walks = core.nextRead
        let oracle = try core.readTree(["windowId": "7", "processStart": "1.2"], request: replayRequest(params))
        rows.append(["task": cell["task"] ?? "fixture", "reused": next["reused"] as? Bool ?? false,
            "walks": walks, "equal": next["text"] as? String == oracle["text"] as? String])
    }
    let data = try JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
} catch {
    FileHandle.standardError.write(Data("\(error)".utf8)); exit(1)
}
