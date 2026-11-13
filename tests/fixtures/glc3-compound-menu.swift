// Decisions arrive from the shared JS request policy in the parent test.
// No request grammar or user-message parser is duplicated in Swift.
for (index, row) in parityRows.enumerated() where row["menuPolicy"] as? Bool == true {
    for lazy in [false, true] {
        let f = CompoundMenuFake()
        f.lazy = lazy
        let label = row["label"] as! String, want = row["want"] as! Bool
        let parent = row["apple"] as! Bool ? "Apple" : "Fixture"
        f.selectors = [DriverCompoundSelector(role: "AXMenuBarItem", source: "title", label: parent),
            DriverCompoundSelector(role: "AXMenuItem", source: "title", label: label)]
        f.nodes[1] = DriverCompoundRawNode(token: "view", parent: "bar", role: "AXMenuBarItem", title: parent,
            description: nil, active: true, enabled: true, secure: false)
        f.nodes[3] = DriverCompoundRawNode(token: "leaf", parent: "menu", role: "AXMenuItem", title: label,
            description: nil, active: lazy, enabled: true, secure: false)
        f.nodes[3].actions = ["AXPress"]
        f.menuAllowed = { _, node in node.role == "AXMenuBarItem" || row["allowed"] as! Bool }
        let machine = try f.machine()
        do {
            let witness = try machine.prepare()
            let receipt = machine.execute(f.grant(witness))
            assertCompound(want && receipt.observed, "shared request allows native menu \(index) lazy \(lazy)")
        } catch let error as DriverCompoundNativeFault {
            assertCompound(!want && error.code == "BOUNDARY_REQUIRED", "shared request refuses native menu \(index) lazy \(lazy)")
        }
        assertCompound(f.targets.count == (want ? 1 : 0), "native menu input count \(index) lazy \(lazy)")
    }
}
do {
    let f = CompoundMenuFake(); f.menuAllowed = nil
    let m = try f.machine()
    nativeReason("BOUNDARY_REQUIRED", "native menu missing parent policy refuses") { _ = try m.prepare() }
}
for lazy in [false, true] {
    let f = CompoundMenuFake(); f.lazy = lazy
    if lazy {
        f.nodes[3] = DriverCompoundRawNode(token: "leaf", parent: "menu", role: "AXMenuItem", title: "Scientific",
            description: nil, active: true, enabled: true, secure: false)
        f.nodes[3].actions = ["AXPress"]
    }
    let machine = try f.machine(), witness = try machine.prepare()
    f.menuAllowed = { _, _ in false }
    let receipt = machine.execute(f.grant(witness))
    assertCompound(!receipt.observed && receipt.delivery == "not-sent" && f.targets.isEmpty,
        "native menu request revoked before execute lazy \(lazy)")
}
do {
    let f = CompoundMenuFake(), machine = try f.machine(), witness = try machine.prepare()
    f.afterConsume = { f.menuAllowed = { _, _ in false } }
    let receipt = machine.execute(f.grant(witness))
    assertCompound(!receipt.observed && receipt.delivery == "not-sent" && f.targets.isEmpty,
        "native menu request revoked during consume")
}
