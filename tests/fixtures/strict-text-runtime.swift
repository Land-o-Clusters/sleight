// AppKit board acquisition is shadowed in this fixture translation unit. The
// real desktop cannot be reached, even by a deliberately regressed dispatcher.
final class PoisonBoard {
    var changeCount: Int { count }
    var bytes = "O", version = 0, count = 0, epoch = 0, writer = 0, lastExternal = 0
    var externalBytes = "O"
    var operations = ["factory": 0, "check": 0, "clear": 0, "write": 0, "provider": 0]
    func forbidden(_ operation: String) throws {
        operations[operation, default: 0] += 1
        if operation == "clear" { bytes = ""; writer = -1 }
        if operation == "write" { bytes = "T"; writer = -1 }
        throw DriverFault("ACTION_UNSUPPORTED", "Fake board access forbidden: \(operation)")
    }
    func check() throws { try forbidden("check") }
    func clear() throws { try forbidden("clear") }
    func write(_ text: String) throws { try forbidden("write") }
    func provider() throws { try forbidden("provider") }
    func external(_ value: String) { version += 1; count += 1; writer = version; lastExternal = version; bytes = value; externalBytes = value }
}
var activeFixture: StrictFixture!
enum NSPasteboard {
    static var general: PoisonBoard {
        get throws { try activeFixture.board.forbidden("factory"); return activeFixture.board }
    }
}
final class StrictFixture {
    let board = PoisonBoard()
    var records = ["snapshot-a": "O:rich:empty-representation", "runtime-snapshot-b": "corrupt:retained"]
    var sends = [0, 0], trace = [String](), boundaries = [String: Int]()
    var metadataCalls = 0, listCalls = 0, scans = [Int](), outcomes = [DriverObject]()
    var eventAt = "", event = "", failAt = "", listFailure = false, micro = "check"
    var mutation = "", mutationHits = [String: Int]()
    var semantic: DriverSemantic?
    func boundary(_ name: String) throws {
        boundaries[name, default: 0] += 1
        let label = "\(name):\(boundaries[name]!)"; trace.append(label)
        if eventAt == label { apply(event) }
        if failAt == label { throw DriverFault("PERSON_TOOK_OVER") }
    }
    func apply(_ op: String) {
        trace.append(op)
        if op.hasPrefix("copy:") { board.external(String(op.dropFirst(5))) }
        if op == "count" { board.count += 17 }
        if op == "epoch" { board.epoch += 1; board.count = 0 }
        if op.hasPrefix("record:") { records["snapshot-\(op.dropFirst(7))"] = op }
    }
    func inventory() {
        let access = DriverLegacyClipboardInventory.Access(metadata: { _ in
            self.metadataCalls += 1; try self.boundary("metadata")
            return .init(mode: mode_t(S_IFDIR | 0o700), uid: getuid())
        }, names: { _ in
            self.listCalls += 1; try self.boundary("list")
            if self.listFailure { throw DriverFault("ACTION_UNSUPPORTED") }
            return Array(self.records.keys)
        })
        do { scans.append(try DriverLegacyClipboardInventory(directory: URL(fileURLWithPath: "/fixture/clipboard"), access: access).scan()) }
        catch { trace.append("scan-refused") }
    }
    func startup() { trace.append("startup"); semantic = DriverSemantic.startup(fixture: nil); inventory() }
    func shutdown() { trace.append("shutdown"); semantic?.shutdown(); semantic = nil }
    func dispatch(_ session: Int, text: String = "T", qualified: Bool = true, unknown: Bool = false) {
        boundaries = [:]; activeFixture = self
        let nonce = String(repeating: "a", count: 64)
        let request = try! DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
            "id": 1, "method": "paste", "params": [:], "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: 0)
        do {
            let result = try request.withSessionCheck({ try self.boundary("check") }) {
                try DriverStrictText.dispatch(request, text: text, format: "text", resolve: {
                    try self.boundary("resolve")
                    if !qualified { throw DriverStrictText.unsupported() }
                    return .unicode
                }, admit: { _ in try self.boundary("admit") }, send: { _ in
                    try self.boundary("send"); self.sends[session] += 1
                }, observe: { _ in
                    try self.boundary("observe")
                    if unknown { throw DriverFault("ACTION_UNCONFIRMED") }
                    return ["delivery": "sent-verified", "retry": "read-first"]
                })
            }
            outcomes.append(result)
        } catch let fault as DriverFault {
            var out = fault.json
            if out["delivery"] == nil { out["delivery"] = request.inputAdmitted ? "unknown" : "not-sent" }
            outcomes.append(out)
        } catch { fatalError("Unexpected fixture failure: \(error)") }
    }
    func snapshot() -> DriverObject {
        ["operations": board.operations, "bytes": board.bytes, "writer": board.writer, "lastExternal": board.lastExternal,
         "version": board.version, "count": board.count, "epoch": board.epoch,
         "records": records, "sends": sends, "trace": trace, "outcomes": outcomes,
         "metadataCalls": metadataCalls, "listCalls": listCalls, "scans": scans, "mutationHits": mutationHits]
    }
}
// Only a local mutation build calls this. It exposes distinct non-atomic calls,
// including a partial destructive operation, instead of supplying fake replace.
func fixtureMutation(_ point: String) throws {
    guard activeFixture.mutation == point else { return }
    // The copied version belongs only to the poison fixture, never AppKit.
    if point == "after-copy" && activeFixture.board.lastExternal == 0 { return }
    activeFixture.trace.append("mutation:\(point)")
    activeFixture.mutationHits[point, default: 0] += 1
    try fixtureForbiddenAccess()
}
func fixtureForbiddenAccess() throws {
    switch activeFixture.micro {
    case "factory": _ = try NSPasteboard.general
    case "clear": try activeFixture.board.clear()
    case "write": try activeFixture.board.write("T")
    case "provider": try activeFixture.board.provider()
    default: try activeFixture.board.check()
    }
}
func attack(_ plan: DriverObject) -> DriverObject {
    let f = StrictFixture(); activeFixture = f
    f.eventAt = plan["eventAt"] as? String ?? ""; f.event = plan["event"] as? String ?? ""
    f.failAt = plan["failAt"] as? String ?? ""; f.micro = plan["micro"] as? String ?? "check"
    f.listFailure = plan["listFailure"] as? Bool ?? false
    f.mutation = plan["mutation"] as? String ?? ""
    for op in plan["ops"] as! [String] {
        if op == "startup" || op == "restart" { f.startup() }
        else if op == "shutdown" { f.shutdown() }
        else if op.hasPrefix("dispatch") {
            let session = op == "dispatch1" ? 1 : 0
            f.dispatch(session, qualified: plan["unqualified"] as? Bool != true, unknown: plan["unknown"] as? Bool == true)
        } else { f.apply(op) }
    }
    return f.snapshot()
}
// Each edge below runs production control flow with injected adapters. Fault choices cut the actual dispatcher
// at every request check and adapter call. A restart invokes the production
// startup, metadata inventory and empty shutdown path. Sessions and external writers are the
// scheduler's state, never a substitute implementation of dispatch. No recovery writer exists.
struct ExploreState: Hashable {
    var sessions = [0, 0], sends = [0, 0], deliveries = ["", ""]
    var bytes = "O", version = 0, count = 0, epoch = 0, writer = 0, lastExternal = 0
}
func explore(_ depth: Int, mutation: String = "") -> DriverObject {
    let initial = ExploreState()
    var seen: Set<ExploreState> = [initial], frontier = [(initial, [String]())]
    var transitions = 0, violations = 0, layers = [1], unknown = 0
    var counterexamples = [[String]](), lifecycleCalls = 0, dispatchCalls = 0
    var violationStages = [String: Int]()
    let cuts = ["", "check:1", "resolve:1", "check:2", "admit:1", "check:3", "send:1", "observe:1"]
    let externalEvents = ["copy:U", "copy:", "copy:T+markers", "copy:O", "count", "epoch"]
    for _ in 0..<depth {
        var upcoming = [(ExploreState, [String])]();
        for (state, history) in frontier {
            func visit(_ next: ExploreState, _ action: String, _ bad: Bool = false, _ stages: [String] = []) {
                transitions += 1
                if bad {
                    violations += 1
                    for stage in stages { violationStages[stage, default: 0] += 1 }
                    if counterexamples.count < 3 { counterexamples.append(history + [action] + stages.map { "mutation:" + $0 }) }
                }
                if seen.insert(next).inserted { upcoming.append((next, history + [action])) }
            }
            for session in 0..<2 {
                if state.sessions[session] == 0 {
                    // Each run enters the production dispatcher. Copies occur
                    // inside its checks/callbacks, including immediately before
                    // a simulated crash, with a fresh version for equal bytes.
                    for cut in cuts {
                      for event in [""] + externalEvents {
                        let f = StrictFixture(); activeFixture = f; f.mutation = mutation
                        f.board.bytes = state.bytes; f.board.version = state.version; f.board.count = state.count
                        f.board.epoch = state.epoch; f.board.writer = state.writer; f.board.lastExternal = state.lastExternal
                        f.board.externalBytes = state.bytes
                        f.sends = state.sends; f.failAt = cut
                        f.eventAt = cut.isEmpty ? "observe:1" : cut; f.event = event
                        let originals = f.records
                        f.dispatch(session); dispatchCalls += 1
                        var next = state
                        next.sessions[session] = cut.isEmpty ? 1 : 2
                        next.sends = f.sends; next.deliveries[session] = f.outcomes.last!["delivery"] as? String ?? ""
                        if next.deliveries[session] == "unknown" { unknown += 1 }
                        next.bytes = f.board.bytes; next.writer = f.board.writer
                        next.version = f.board.version; next.count = f.board.count; next.epoch = f.board.epoch
                        next.lastExternal = f.board.lastExternal
                        let bad = f.board.operations.values.contains { $0 > 0 } || f.records != originals ||
                            next.bytes != f.board.externalBytes || next.writer != next.lastExternal || next.sends[session] > 1
                        visit(next, "dispatch\(session):\(cut.isEmpty ? "complete" : cut):\(event)", bad, Array(f.mutationHits.keys).sorted())
                      }
                    }
                }
                if state.sessions[session] != 2 {
                    var next = state; next.sessions[session] = 2
                    visit(next, "crash\(session)")
                } else {
                    let f = StrictFixture(); activeFixture = f; f.mutation = mutation; f.sends = state.sends
                    f.board.bytes = state.bytes; f.board.version = state.version; f.board.count = state.count
                    f.board.epoch = state.epoch; f.board.writer = state.writer; f.board.lastExternal = state.lastExternal
                    let originals = f.records
                    f.startup(); f.shutdown(); lifecycleCalls += 1
                    var next = state; next.sessions[session] = 1
                    visit(next, "restart\(session)", f.records != originals || f.sends != state.sends ||
                        f.board.bytes != state.bytes || f.board.writer != state.writer || f.board.operations.values.contains { $0 > 0 }, Array(f.mutationHits.keys).sorted())
                }
            }
            for value in ["U", "", "T+markers", "O"] {
                var next = state; next.bytes = value; next.version += 1; next.count += 1
                next.writer = next.version; next.lastExternal = next.version
                visit(next, "copy:\(value)")
            }
            var next = state; next.count += 17; visit(next, "count-only")
            next = state; next.epoch += 1; next.count = 0; visit(next, "server-restart")
        }
        frontier = upcoming; layers.append(frontier.count)
    }
    return ["depth": depth, "states": seen.count, "transitions": transitions, "violations": violations,
            "terminalUnknown": unknown, "layers": layers, "counterexamples": counterexamples,
            "dispatchCalls": dispatchCalls, "lifecycleCalls": lifecycleCalls, "violationStages": violationStages, "checkpointChoices": cuts.count,
            "externalChoices": externalEvents.count + 1]
}
let command = try! DriverJSON.decode(Data(readLine()!.utf8))
let output = command["explore"] as? Int != nil ? explore(command["explore"] as! Int, mutation: command["mutation"] as? String ?? "") : attack(command)
print(String(data: try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
