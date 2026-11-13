final class CompoundNativeFake {
    var cancelled = false
    var stage = 0
    var sequence: UInt64 = 0
    var clock: Double = 1000
    var epoch: UInt64 = 0
    var readID = 0
    var complete = true
    var coherent = true
    var modalAbsent = true
    var background = true
    var qualified = true
    var local = true
    var authority = true
    var settled = true
    var wrongEffect = false
    var destination = true
    var throwAfterInput = false
    var helper = "native-helper-1"
    var document = "document-A"
    var trueRecipient = "document-A"
    var recipients: [String] = []
    var primitives: [String] = []
    var written: [String] = []
    var afterConsume: (() -> Void)?
    var targetHelp: String?
    var afterPerform: (() -> Void)?
    let saving: Bool
    var contracts: [DriverCompoundMechanismContract] = []
    init(saving: Bool = false) {
        self.saving = saving
        for (index, kind) in (saving ? [DriverCompoundKind.saveDirectory, .saveBasename] : [.menuOpen, .menuCommand]).enumerated() {
            contracts.append(DriverCompoundMechanismContract(id: "fake-\(index)", kind: kind,
                qualifies: { [unowned self] _, _ in self.qualified },
                effect: { before, after, _, _ in before.meaning == Data("state-\(index)".utf8) &&
                    after.meaning == Data("state-\(index + 1)".utf8) }))
        }
    }
    var recipient: DriverCompoundRecipient {
        DriverCompoundRecipient(bundle: "test.compound.App", pid: 123, processStart: "start-1", helper: helper,
            window: "42", root: "root", document: document, responder: document, mainWindow: "42")
    }
    var plan: [DriverCompoundTransition] {
        if saving {
            return [DriverCompoundTransition(kind: .saveDirectory, selector: DriverCompoundSelector(role: "AXTextField", source: "title", label: "Where"), owner: "root", value: "/fixtures/project"),
                DriverCompoundTransition(kind: .saveBasename, selector: DriverCompoundSelector(role: "AXTextField", source: "title", label: "Save As"), owner: "root", value: "Pay.txt")]
        }
        return [DriverCompoundTransition(kind: .menuOpen, selector: DriverCompoundSelector(role: "AXMenuBarItem", source: "title", label: "Edit"), owner: "root", value: nil),
            DriverCompoundTransition(kind: .menuCommand, selector: DriverCompoundSelector(role: "AXMenuItem", source: "title", label: "Find"), owner: nil, value: nil)]
    }
    func observation() -> DriverCompoundObservation {
        readID += 1
        let label = saving ? (stage == 0 ? "Where" : "Save As") : (stage == 0 ? "Edit" : "Find")
        let token = stage == 0 ? "first" : "second", domain = saving ? "panel" : stage == 0 ? "bar" : "owned"
        let role = saving ? "AXTextField" : stage == 0 ? "AXMenuBarItem" : "AXMenuItem"
        var nodes = [DriverCompoundRawNode(token: token, parent: domain, role: role, title: label, description: nil,
            help: targetHelp, active: true, enabled: true, secure: false)]
        if !saving && stage == 0 { nodes.append(DriverCompoundRawNode(token: "bar", parent: "root", role: "AXMenuBar", title: nil,
            description: nil, active: true, enabled: true, secure: false)) }
        nodes[0].actions = saving ? ["AXSetValue"] : ["AXPress"]
        return DriverCompoundObservation(read: readID, epoch: epoch, recipient: recipient, complete: complete,
            coherent: coherent, inventoryComplete: true, modalAbsent: modalAbsent, background: background,
            domain: domain, owner: saving || stage == 0 ? "root" : "first", ownerProved: true,
            nodes: nodes, meaning: Data("state-\(stage)".utf8))
    }
    func machine() throws -> DriverCompoundMachine {
        let bound = recipient
        return try DriverCompoundMachine(execution: "native-operation", recipient: bound, plan: plan,
            savePreparation: saving, deadline: 31000, contracts: contracts,
            providers: DriverCompoundNativeProviders(now: { self.clock }, person: {
                DriverCompoundPersonSample(at: self.clock, lastInput: 0, sequence: self.sequence, valid: true,
                    targetScopedQuiet: true, heldModifiers: false, heldButtons: false, secureInput: false,
                    locked: false, onConsole: true, focusChanged: false)
            }, authorizeRead: { if !self.authority { throw DriverCompoundNativeFault("APP_DECLINED") } },
            read: { self.observation() }, classifyLocal: { _, _, _ in self.local },
            mechanism: { kind, _ in self.qualified ? self.contracts.first(where: { $0.kind == kind }) : nil },
            consume: { grant, witness in
                self.afterConsume?()
                guard self.authority, grant.opaque == "grant-\(witness.ordinal)" else { throw DriverCompoundNativeFault("APP_DECLINED") }
            }, perform: { primitive, _, value in
                self.primitives.append(primitive); self.recipients.append(self.trueRecipient)
                if let value = value { self.written.append(value) }
                if !self.wrongEffect { self.stage += 1; self.epoch += 1 }
                self.afterPerform?()
                if self.throwAfterInput { throw DriverCompoundNativeFault("HELPER_FAILED") }
                return "sent-unverified"
            }, settle: { self.settled }, destinationVerified: { _ in self.destination }, checkStop: {
                if self.cancelled { throw DriverCompoundNativeFault("USER_STOPPED") }
            }, menuRequestAllowed: { _, _ in true }))
    }
    func grant(_ witness: DriverCompoundNativeWitness, helper: String? = nil) -> DriverCompoundNativeGrant {
        DriverCompoundNativeGrant(execution: witness.execution, helper: helper ?? self.helper, ordinal: witness.ordinal,
            opaque: "grant-\(witness.ordinal)", meaning: witness.before.meaning)
    }
}
func nativeReason(_ expected: String, _ name: String, _ body: () throws -> Void) {
    do { try body(); fatalError(name) }
    catch let error as DriverCompoundNativeFault { assertCompound(error.code == expected, name) }
    catch let error as DriverCompoundStop { assertCompound(error.rawValue == expected, name) }
    catch { fatalError(name) }
}
do {
    let f = CompoundNativeFake(), machine = try f.machine()
    let a = try machine.prepare(), grant = f.grant(a)
    let first = machine.execute(grant), duplicate = machine.execute(grant)
    assertCompound(first.observed && duplicate.observed && f.primitives.count == 1, "native duplicate execute is receipt only")
    try machine.acknowledge(0)
    let b = try machine.prepare(); let second = machine.execute(f.grant(b)); try machine.acknowledge(1)
    assertCompound(second.observed && machine.state == "completed", "native two-step menu reaches expected terminal")
    assertCompound(machine.completedPrefix == 2 && machine.unknownStep == nil && f.primitives.count == 2, "native exact acknowledged prefix")
    assertCompound(!machine.saved && !machine.commitSent, "native menu cannot report a save")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.epoch += 1
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "WITNESS_CHANGED" && f.primitives.isEmpty, "native epoch drift prevents dispatch")
    nativeReason("WITNESS_CHANGED", "native stopped helper never resumes") { _ = try machine.prepare() }
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    let receipt = machine.execute(f.grant(witness, helper: "old-helper"))
    assertCompound(receipt.reason == "STALE_GRANT" && f.primitives.isEmpty, "native old helper grant refuses")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    _ = machine.execute(f.grant(witness)); try machine.acknowledge(0); f.sequence += 1
    nativeReason("PERSON_TOOK_OVER", "native person watch spans RPC and acknowledgment") { _ = try machine.prepare() }
    f.sequence = 0
    nativeReason("PERSON_TOOK_OVER", "native global takeover remains latched") { _ = try machine.prepare() }
    assertCompound(f.primitives.count == 1, "native takeover leaves second input unsent")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.local = false
    nativeReason("BOUNDARY_REQUIRED", "native contextual boundary stops before input") { _ = try machine.prepare() }
    assertCompound(f.primitives.isEmpty, "native boundary mutation count zero")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.qualified = false
    nativeReason("UNSUPPORTED_TRANSITION", "native identical AX with unqualified callback refuses") { _ = try machine.prepare() }
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.wrongEffect = true
    let witness = try machine.prepare(), receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.delivery == "sent-unverified" && !receipt.observed, "native API success is not effect evidence")
    assertCompound(machine.completedPrefix == 0 && machine.unknownStep == 0 && f.primitives.count == 1, "native unresolved primitive retains unsent suffix")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.throwAfterInput = true
    let witness = try machine.prepare(), receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.delivery == "unknown" && f.primitives.count == 1, "native crash after mutation never becomes not-sent")
    let duplicate = machine.execute(f.grant(witness))
    assertCompound(duplicate.delivery == "unknown" && f.primitives.count == 1, "native uncertain execute never retries")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare(); f.authority = false
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "APP_DECLINED" && receipt.attempts == 0 && f.primitives.isEmpty, "native revocation before dispatch")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.afterPerform = { f.clock = 31000 }
    let witness = try machine.prepare(), receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "DEADLINE_EXCEEDED" && f.primitives.count == 1, "native whole-operation deadline")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(); f.afterPerform = { f.complete = false }
    let witness = try machine.prepare(), receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "OBSERVATION_INCOMPLETE" && f.primitives.count == 1, "native complete read required after settle")
}
do {
    let f = CompoundNativeFake(saving: true), machine = try f.machine()
    for i in 0..<2 { let witness = try machine.prepare(); _ = machine.execute(f.grant(witness)); try machine.acknowledge(i) }
    assertCompound(machine.state == "prepared" && !machine.saved && !machine.commitSent, "native Save preparation never commits")
    assertCompound(f.primitives == ["write", "write"] && f.written == ["/fixtures/project", "Pay.txt"], "native Save fields use two direct writes")
}
do {
    let f = CompoundNativeFake(saving: true), machine = try f.machine(); f.destination = false
    let a = try machine.prepare(); _ = machine.execute(f.grant(a)); try machine.acknowledge(0)
    let b = try machine.prepare(), receipt = machine.execute(f.grant(b))
    assertCompound(receipt.reason == "DESTINATION_UNVERIFIED" && machine.completedPrefix == 1, "native destination uncertainty retains prefix")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.trueRecipient = "document-B" // Deliberately invisible to AX, after the last prepared read.
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.observed && f.recipients == ["document-B"], "native residual non-atomic recipient counterexample")
}

do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.afterConsume = { f.sequence += 1 }
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "PERSON_TOOK_OVER" && f.primitives.isEmpty, "native dispatch re-samples after consume")
}
for label in ["Confirm", "Submit", "Send", "Transfer", "Order", "Book", "Buy", "Delete", "Sign-in", "Sign_up", "Security", "Privacy", "Consent", "ＣＯＮＦＩＲＭ", "Con\u{200b}firm", "Sіgn-in", "確認", "付款", "결제", "Account", "Secure", "Credit card"] {
    let f = CompoundNativeFake(), machine = try f.machine(); f.targetHelp = label
    nativeReason("BOUNDARY_REQUIRED", "native real target Help boundary " + label) { _ = try machine.prepare() }
    assertCompound(f.primitives.isEmpty, "native boundary has zero input " + label)
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.targetHelp = "Send"
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "BOUNDARY_REQUIRED" && f.primitives.isEmpty, "native execute checks current Help even if provider meaning omits it")
}

do {
    var node = DriverCompoundRawNode(token: "v", parent: "bar", role: "AXMenuItem", title: "Local lookup", description: nil,
        active: true, enabled: true, secure: false)
    node.value = "Send"
    assertCompound(!DriverCompoundBoundary.local(node, kind: .menuCommand), "native menu Value is also a consequential label")
}


do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.afterConsume = { f.cancelled = true }
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "USER_STOPPED" && f.primitives.isEmpty, "Stop before compound dispatch sends nothing")
}
do {
    let f = CompoundNativeFake(), machine = try f.machine(), witness = try machine.prepare()
    f.afterPerform = { f.cancelled = true }
    let receipt = machine.execute(f.grant(witness))
    assertCompound(receipt.reason == "USER_STOPPED" && f.primitives.count == 1, "Stop after compound dispatch sends no second step")
    nativeReason("USER_STOPPED", "stopped compound cannot prepare another input") { _ = try machine.prepare() }
}

// JSON labels come from the same JS table and RT11J probes as the numbered test.
// Swift strings cannot represent lone UTF-16 surrogates. The JS sender supplies
// nil for those ill-formed labels, which must also fail closed.
let parityData = FileHandle.standardInput.readDataToEndOfFile()
let parityRows = try JSONSerialization.jsonObject(with: parityData) as! [[String: Any]]
for (index, row) in parityRows.enumerated() where row["menuPolicy"] == nil {
    let target = DriverCompoundRawNode(token: "parity", parent: "menu", role: "AXMenuItem",
        title: row["label"] as? String, description: nil, active: true, enabled: true, secure: false)
    assertCompound(DriverCompoundBoundary.local(target, kind: .menuCommand) == (row["local"] as! Bool),
        "JS Swift shared label \(index)")
}
