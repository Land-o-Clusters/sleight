// Pure providers only. These tests never construct AXUIElement or an app host.
final class CompoundMenuFake {
    var readID = 0
    var epoch: UInt64 = 0
    var complete = true
    var authority = true
    var sequence: UInt64 = 0
    var processStart = "start-1"
    var helper = "menu-helper"
    var ignored = false
    var qualified = true
    var targets: [String] = []
    var afterConsume: (() -> Void)?
    var menuAllowed: ((DriverCompoundObservation, DriverCompoundRawNode) -> Bool)? = { _, _ in true }
    var nodes = [
        DriverCompoundRawNode(token: "bar", parent: "root", role: "AXMenuBar", title: nil, description: nil,
            active: true, enabled: true, secure: false),
        DriverCompoundRawNode(token: "view", parent: "bar", role: "AXMenuBarItem", title: "View", description: nil,
            active: true, enabled: true, secure: false),
        DriverCompoundRawNode(token: "menu", parent: "view", role: "AXMenu", title: nil, description: nil,
            active: false, enabled: true, secure: false),
        DriverCompoundRawNode(token: "leaf", parent: "menu", role: "AXMenuItem", title: "Scientific", description: nil,
            active: false, enabled: true, secure: false)
    ]
    var selectors = [DriverCompoundSelector(role: "AXMenuBarItem", source: "title", label: "View"),
        DriverCompoundSelector(role: "AXMenuItem", source: "title", label: "Scientific")]
    init() { nodes[3].actions = ["AXPress"] }
    var recipient: DriverCompoundRecipient {
        DriverCompoundRecipient(bundle: "test.compound.App", pid: 123, processStart: processStart, helper: helper,
            window: "42", root: "root", document: "document-A", responder: "document-A", mainWindow: "42")
    }
    var lazy = false
    lazy var contract = DriverCompoundMechanismContract(id: "fake-direct", kind: lazy ? .menuCommand : .menuDirect,
        qualifies: { [unowned self] _, node in self.qualified && node.token == "leaf" },
        effect: { before, after, _, _ in before.meaning == Data("state-0".utf8) && after.meaning == Data("state-1".utf8) })
    func machine() throws -> DriverCompoundMachine {
        try DriverCompoundMachine(execution: "native-direct", recipient: recipient,
            plan: lazy ? [DriverCompoundTransition(kind: .menuCommand, selector: selectors[1], owner: "root", value: nil)] : [DriverCompoundTransition(kind: .menuOpen, selector: selectors[0], owner: "root", value: nil),
                DriverCompoundTransition(kind: .menuCommand, selector: selectors[1], owner: nil, value: nil)],
            savePreparation: false, deadline: 31000, contracts: [contract],
            providers: DriverCompoundNativeProviders(now: { 1000 }, person: {
                DriverCompoundPersonSample(at: 1000, lastInput: 0, sequence: self.sequence, valid: true,
                    targetScopedQuiet: true, heldModifiers: false, heldButtons: false, secureInput: false,
                    locked: false, onConsole: true, focusChanged: false)
            }, authorizeRead: { if !self.authority { throw DriverCompoundNativeFault("APP_DECLINED") } },
            read: {
                self.readID += 1
                return DriverCompoundObservation(read: self.readID, epoch: self.epoch, recipient: self.recipient,
                    complete: self.complete, coherent: true, inventoryComplete: true, modalAbsent: true,
                    background: true, domain: self.lazy ? "menu" : "bar", owner: "root", ownerProved: true, nodes: self.nodes,
                    meaning: Data("state-\(self.epoch)".utf8))
            }, classifyLocal: { _, _, _ in true }, mechanism: { kind, _ in kind == self.contract.kind ? self.contract : nil },
            consume: { _, _ in
                self.afterConsume?()
                if !self.authority { throw DriverCompoundNativeFault("LEASE_REFUSED") }
            }, perform: { primitive, node, _ in
                guard primitive == "press" else { throw DriverCompoundNativeFault("UNSUPPORTED_TRANSITION") }
                self.targets.append(node.token)
                if !self.ignored { self.epoch += 1 }
                return "sent-unverified"
            }, settle: { true }, destinationVerified: { _ in false }, menuRequestAllowed: { observed, node in
                self.menuAllowed?(observed, node) == true
            }))
    }
    func grant(_ w: DriverCompoundNativeWitness) -> DriverCompoundNativeGrant {
        DriverCompoundNativeGrant(execution: w.execution, helper: w.recipient.helper, ordinal: w.ordinal,
            opaque: "direct-grant", meaning: w.before.meaning)
    }
}
do {
    let f = CompoundMenuFake(), m = try f.machine(), w = try m.prepare()
    assertCompound(w.transition.kind == .menuDirect && w.node.token == "leaf", "native unopened route selects leaf")
    let r = m.execute(f.grant(w)); try m.acknowledge(0)
    assertCompound(r.observed && m.state == "completed" && m.receipts.count == 1, "native unopened route has one acknowledged step")
    assertCompound(f.targets == ["leaf"], "native unopened route never presses parent")
    assertCompound(r.detail == "Pressed the menu item through Accessibility without opening the menu.", "native direct result names Accessibility")
    _ = m.execute(f.grant(w))
    assertCompound(f.targets == ["leaf"], "native direct duplicate cannot press twice")
}
for enabled in [true, false] {
    let f = CompoundMenuFake(); f.ignored = true
    f.nodes[3] = DriverCompoundRawNode(token: "leaf", parent: "menu", role: "AXMenuItem", title: "Scientific", description: nil,
        active: false, enabled: enabled, secure: false)
    f.nodes[3].actions = ["AXPress"]
    let m = try f.machine(), w = try m.prepare(), r = m.execute(f.grant(w))
    assertCompound(r.reason == "ACTION_UNCONFIRMED" && !r.observed, "native ignored enabled=\(enabled) stays uncertain")
    assertCompound(r.afterRead != nil && m.nextObservation?.read == r.afterRead, "native ignored enabled=\(enabled) retains next read")
    _ = m.execute(f.grant(w))
    assertCompound(f.targets == ["leaf"] && m.unknownStep == 0, "native ignored enabled=\(enabled) never retries")
    nativeReason("ACTION_UNCONFIRMED", "native ignored cannot resume enabled=\(enabled)") { _ = try m.prepare() }
}
for change in ["start", "helper", "epoch", "authority", "person"] {
    let f = CompoundMenuFake(), m = try f.machine(), w = try m.prepare()
    let expected: String
    switch change {
    case "start": f.processStart = "start-2"; expected = "IDENTITY_CHANGED"
    case "helper": f.helper = "replacement"; expected = "IDENTITY_CHANGED"
    case "epoch": f.epoch += 1; expected = "WITNESS_CHANGED"
    case "authority": f.authority = false; expected = "APP_DECLINED"
    default: f.afterConsume = { f.sequence += 1 }; expected = "PERSON_TOOK_OVER"
    }
    let r = m.execute(f.grant(w))
    assertCompound(r.reason == expected && f.targets.isEmpty, "native direct rechecks \(change)")
}
for index in [1, 3] {
    let f = CompoundMenuFake(); let n = f.nodes[index]
    f.nodes.append(DriverCompoundRawNode(token: "twin", parent: n.parent, role: n.role, title: n.title,
        description: nil, active: false, enabled: false, secure: false))
    let m = try f.machine()
    nativeReason("AMBIGUOUS_STEP", "native dormant disabled twin depth=\(index)") { _ = try m.prepare() }
    assertCompound(f.targets.isEmpty, "native twin never probes parent depth=\(index)")
}
do {
    let f = CompoundMenuFake(); f.nodes[2].childrenComplete = false
    let m = try f.machine()
    nativeReason("OBSERVATION_INCOMPLETE", "native unopened incomplete children stop") { _ = try m.prepare() }
}
do {
    let f = CompoundMenuFake(); f.nodes.removeLast()
    let path = try DriverCompoundResolver.unopened(f.selectors, bar: "bar", ownerProved: true, nodes: f.nodes)
    assertCompound(path == nil,
        "native missing leaf alone selects lazy fallback")
}
do {
    let f = CompoundMenuFake(); f.nodes.append(DriverCompoundRawNode(token: "rival", parent: "bar", role: "AXMenuItem",
        title: "Scientific", description: nil, active: false, enabled: true, secure: false))
    let p = try DriverCompoundResolver.unopened(f.selectors, bar: "bar", ownerProved: true, nodes: f.nodes)
    assertCompound(p?.last?.token == "leaf", "native literal path ignores other branch")
}
for label in ["Pay", "Delete", "Confirmé", "ВUY", "SEΝD"] {
    let f = CompoundMenuFake(); f.nodes[1].help = label
    let m = try f.machine()
    nativeReason("BOUNDARY_REQUIRED", "native dormant ancestor boundary \(label)") { _ = try m.prepare() }
    assertCompound(f.targets.isEmpty, "native boundary cannot open parent \(label)")
}
do {
    let f = CompoundMenuFake(); f.nodes[3].actions = []
    let m = try f.machine()
    nativeReason("UNSUPPORTED_TRANSITION", "native direct requires AXPress without alternate mechanism") { _ = try m.prepare() }
}
