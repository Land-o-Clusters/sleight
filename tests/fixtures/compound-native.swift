func assertCompound(_ condition: @autoclosure () -> Bool, _ name: String) {
    guard condition() else { fatalError(name) }
    print("{\"pass\":true,\"name\":\"\(name)\"}")
}
func expectCompound(_ code: DriverCompoundStop, _ name: String, _ body: () throws -> Void) {
    do { try body(); fatalError(name) } catch let error as DriverCompoundStop { assertCompound(error == code, name) }
    catch { fatalError(name) }
}
assertCompound("é" == "e\u{301}", "Swift canonical equivalence control")
for (a, b, name) in [("é", "e\u{301}", "decomposed"), ("Save", "Save…", "ellipsis"),
                      ("Save", "save", "case"), ("Save", "Save ", "space"), ("Save", "Save\u{200b}", "zero width")] {
    assertCompound(!DriverCompoundRaw.equal(a, b), "raw identity \(name)")
}
assertCompound(DriverCompoundRaw.equal("17", "17"), "numeric label remains literal")
let selector = DriverCompoundSelector(role: "AXMenuItem", source: "title", label: "Coast")
func node(_ token: String, _ name: String, _ active: Bool = true, _ enabled: Bool = true, _ parent: String = "owned") -> DriverCompoundRawNode {
    DriverCompoundRawNode(token: token, parent: parent, role: "AXMenuItem", title: name, description: nil,
                          active: active, enabled: enabled, secure: false)
}
let coast = node("coast", "Coast"), coastal = node("coastal", "Coastal"), hidden = node("hidden", "Coast", false)
let selected = try DriverCompoundResolver.exact(selector, container: "owned", complete: true, ownerProved: true, nodes: [coast, coastal, hidden])
assertCompound(selected.token == "coast", "exact scoped match ignores dormant branch")
expectCompound(.ambiguous, "disabled duplicate still ambiguous") {
    _ = try DriverCompoundResolver.exact(selector, container: "owned", complete: true, ownerProved: true, nodes: [coast, node("twin", "Coast", true, false)])
}
expectCompound(.incomplete, "partial sibling domain") {
    _ = try DriverCompoundResolver.exact(selector, container: "owned", complete: false, ownerProved: true, nodes: [coast])
}
expectCompound(.incomplete, "owner relation absent") {
    _ = try DriverCompoundResolver.exact(selector, container: "owned", complete: true, ownerProved: false, nodes: [coast])
}
expectCompound(.missing, "foreign container never searched") {
    _ = try DriverCompoundResolver.exact(selector, container: "other", complete: true, ownerProved: true, nodes: [coast])
}
func sample(_ sequence: UInt64, _ last: Double = 0, _ quiet: Bool = true) -> DriverCompoundPersonSample {
    DriverCompoundPersonSample(at: 1000, lastInput: last, sequence: sequence, valid: true, targetScopedQuiet: quiet,
        heldModifiers: false, heldButtons: false, secureInput: false, locked: false, onConsole: true, focusChanged: false)
}
let watch = DriverCompoundGlobalWatch()
try watch.check(sample(0))
try watch.check(sample(0))
assertCompound(watch.stopped == nil, "same watch across quiet RPCs")
expectCompound(.takeover, "global sequence catches another app input") { try watch.check(sample(1)) }
expectCompound(.takeover, "takeover remains sticky across later quiet RPC") { try watch.check(sample(0)) }
let timestampWatch = DriverCompoundGlobalWatch()
try timestampWatch.check(sample(0))
expectCompound(.takeover, "global last event catches sequence loss") { try timestampWatch.check(sample(0, 1)) }
