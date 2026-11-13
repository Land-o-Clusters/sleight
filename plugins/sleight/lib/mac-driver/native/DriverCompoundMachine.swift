import Foundation

// Pure helper-side transaction kernel. It is intentionally unregistered and
// has no AX, input, filesystem, clipboard, renderer or system person provider.
// The parent JSON parser freezes the high-level request. A future closed native
// transport translates it into these typed transitions under parent admission.
enum DriverCompoundKind: String {
    case menuOpen, menuExpand, menuCommand, menuDirect, chooseOpen, chooseSelect
    case saveOpen, saveDirectory, saveBasename
    var primitive: String { self == .saveDirectory || self == .saveBasename ? "write" : "press" }
    var role: String {
        switch self {
        case .menuOpen: return "AXMenuBarItem"
        case .chooseOpen: return "AXPopUpButton"
        case .saveDirectory, .saveBasename: return "AXTextField"
        default: return "AXMenuItem"
        }
    }
}

struct DriverCompoundRecipient {
    let bundle: String
    let pid: Int
    let processStart: String
    let helper: String
    let window: String
    let root: String
    let document: String
    let responder: String
    let mainWindow: String
    func same(_ other: DriverCompoundRecipient) -> Bool {
        pid == other.pid && zip([bundle, processStart, helper, window, root, document, responder, mainWindow],
            [other.bundle, other.processStart, other.helper, other.window, other.root, other.document,
             other.responder, other.mainWindow]).allSatisfy { DriverCompoundRaw.equal($0.0, $0.1) }
    }
}

struct DriverCompoundTransition {
    let kind: DriverCompoundKind
    let selector: DriverCompoundSelector
    // An opaque retained owner, not a printed element number or an AXIdentifier.
    // nil means the preceding transition's retained token. At step zero use root.
    let owner: String?
    let value: String?
    var menuPath: [DriverCompoundSelector]? = nil
}

struct DriverCompoundObservation {
    let read: Int
    let epoch: UInt64
    let recipient: DriverCompoundRecipient
    let complete: Bool
    let coherent: Bool
    let inventoryComplete: Bool
    let modalAbsent: Bool
    let background: Bool
    let domain: String
    let owner: String
    let ownerProved: Bool
    let nodes: [DriverCompoundRawNode]
    // Exhaustive raw UTF-16 identity/context serialization from the authorized
    // provider, including siblings, values, actions and command metadata. It
    // excludes only the read sequence; it is never printed, hashed or persisted.
    let meaning: Data
}

struct DriverCompoundNativeFault: Error, CustomStringConvertible {
    let code: String
    let step: String?
    init(_ code: String, step: String? = nil) { self.code = code; self.step = step }
    var description: String { code + (step.map { " step=" + $0 } ?? "") }
}

final class DriverCompoundMechanismContract {
    let id: String
    let kind: DriverCompoundKind
    let qualifies: (DriverCompoundObservation, DriverCompoundRawNode) -> Bool
    let effect: (DriverCompoundObservation, DriverCompoundObservation, DriverCompoundRawNode, String?) -> Bool
    init(id: String, kind: DriverCompoundKind,
         qualifies: @escaping (DriverCompoundObservation, DriverCompoundRawNode) -> Bool,
         effect: @escaping (DriverCompoundObservation, DriverCompoundObservation, DriverCompoundRawNode, String?) -> Bool) {
        self.id = id; self.kind = kind; self.qualifies = qualifies; self.effect = effect
    }
}

struct DriverCompoundNativeWitness {
    let execution: String
    let ordinal: Int
    let recipient: DriverCompoundRecipient
    let before: DriverCompoundObservation
    let transition: DriverCompoundTransition
    let node: DriverCompoundRawNode
    let contract: DriverCompoundMechanismContract
}

struct DriverCompoundNativeGrant {
    let execution: String
    let helper: String
    let ordinal: Int
    let opaque: String
    let meaning: Data
}

struct DriverCompoundNativeReceipt {
    let ordinal: Int
    var beforeRead: Int?
    var afterRead: Int?
    var attempts = 0
    var delivery = "not-sent"
    var observed = false
    var reason: String?
    var detail: String?
}

struct DriverCompoundNativeProviders {
    let now: () -> Double
    let person: () throws -> DriverCompoundPersonSample
    // Approval and scope acquisition precede every read, including child scopes.
    let authorizeRead: () throws -> Void
    let read: () throws -> DriverCompoundObservation
    let classifyLocal: (DriverCompoundTransition, DriverCompoundObservation, DriverCompoundRawNode) -> Bool
    // Return a registry-owned contract object, never an app-provided descriptor.
    let mechanism: (DriverCompoundKind, DriverCompoundRawNode) throws -> DriverCompoundMechanismContract?
    // This synchronous parent admission check is the dispatch linearization point.
    let consume: (DriverCompoundNativeGrant, DriverCompoundNativeWitness) throws -> Void
    let perform: (String, DriverCompoundRawNode, String?) throws -> String
    let settle: () throws -> Bool
    let destinationVerified: (DriverCompoundObservation) -> Bool
    var checkStop: () throws -> Void = {}
    // Parent adapter calls the shared session-menu.mjs request policy with its
    // authenticated message state and this raw node's ancestry. Never derive
    // authority from a selector, AX text, or the mechanism classifier.
    var menuRequestAllowed: ((DriverCompoundObservation, DriverCompoundRawNode) -> Bool)? = nil
}

final class DriverCompoundMachine {
    let execution: String
    let recipient: DriverCompoundRecipient
    private var plan: [DriverCompoundTransition]
    private let savePreparation: Bool
    private let deadline: Double
    private let providers: DriverCompoundNativeProviders
    private let watch = DriverCompoundGlobalWatch()
    private let contracts: [DriverCompoundMechanismContract]
    private var prepared: DriverCompoundNativeWitness?
    private var previous: DriverCompoundObservation?
    private var priorToken: String?
    private var lastRead = 0
    private var grants = Set<String>()
    private var awaitingAck = false
    private(set) var ordinal = 0
    private(set) var ended: String?
    private(set) var state = "stopped"
    private(set) var receipts: [DriverCompoundNativeReceipt]
    private(set) var nextObservation: DriverCompoundObservation?

    init(execution: String, recipient: DriverCompoundRecipient, plan: [DriverCompoundTransition],
         savePreparation: Bool, deadline: Double, contracts: [DriverCompoundMechanismContract] = [],
         providers: DriverCompoundNativeProviders) throws {
        guard !execution.isEmpty, !plan.isEmpty, plan.count <= 32, deadline.isFinite,
              deadline > providers.now(), deadline - providers.now() <= 30000,
              plan.allSatisfy({ $0.kind != .menuDirect && $0.selector.label.utf16.count > 0 && $0.selector.label.utf16.count <= 512 &&
                  ["title", "description"].contains($0.selector.source) && $0.selector.role == $0.kind.role &&
                  !$0.selector.label.unicodeScalars.contains(where: { [.control, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) }) }),
              !savePreparation || plan.allSatisfy({ [.saveOpen, .saveDirectory, .saveBasename].contains($0.kind) }) else {
            throw DriverCompoundNativeFault("INVALID_INTENT")
        }
        self.execution = execution; self.recipient = recipient; self.plan = plan; self.savePreparation = savePreparation
        self.deadline = deadline; self.contracts = contracts; self.providers = providers
        receipts = plan.indices.map { DriverCompoundNativeReceipt(ordinal: $0) }
    }
    private func check() throws {
        try providers.checkStop()
        if let reason = ended { throw DriverCompoundNativeFault(reason) }
        guard providers.now() < deadline else { throw DriverCompoundNativeFault("DEADLINE_EXCEEDED") }
        try watch.check(providers.person())
    }
    private func read() throws -> DriverCompoundObservation {
        try check(); try providers.authorizeRead(); try check()
        let observed = try providers.read()
        guard observed.read > lastRead else { throw DriverCompoundNativeFault("INCOHERENT_OBSERVATION") }
        lastRead = observed.read
        guard recipient.same(observed.recipient) else { throw DriverCompoundNativeFault("IDENTITY_CHANGED", step: "compound-recipient") }
        guard observed.complete, observed.coherent, observed.inventoryComplete else {
            throw DriverCompoundNativeFault("OBSERVATION_INCOMPLETE")
        }
        guard !observed.meaning.isEmpty, observed.meaning.count <= 64 * 1024 * 1024, observed.nodes.count <= 10000 else {
            throw DriverCompoundNativeFault("OBSERVATION_INCOMPLETE")
        }
        guard observed.modalAbsent else { throw DriverCompoundNativeFault("MODAL_APPEARED") }
        guard observed.background else { throw DriverCompoundNativeFault("BACKGROUND_UNAVAILABLE") }
        try check(); return observed
    }
    private func failure(_ error: Error) -> String {
        if let fault = error as? DriverCompoundNativeFault { return fault.code }
        if let fault = error as? DriverCompoundStop { return fault.rawValue }
        return "HELPER_FAILED"
    }
    func stop(_ reason: String) { if ended == nil { ended = reason }; prepared = nil; state = "stopped" }
    private func local(_ node: DriverCompoundRawNode, _ transition: DriverCompoundTransition,
                       _ observed: DriverCompoundObservation) -> Bool {
        guard DriverCompoundBoundary.local(node, kind: transition.kind),
              providers.classifyLocal(transition, observed, node) else { return false }
        if ["AXMenuItem", "AXMenuBarItem"].contains(node.role) {
            return providers.menuRequestAllowed?(observed, node) == true
        }
        return true
    }
    func prepare() throws -> DriverCompoundNativeWitness {
        do {
            try check()
            guard ordinal < plan.count, prepared == nil, !awaitingAck else { throw DriverCompoundNativeFault("STALE_GRANT") }
            let before = try read()
            var transition = plan[ordinal]
            if let prior = previous, prior.meaning != before.meaning || prior.epoch != before.epoch {
                throw DriverCompoundNativeFault("CONTEXT_DRIFT")
            }
            let owner = transition.owner ?? priorToken ?? recipient.root
            guard before.ownerProved, DriverCompoundRaw.equal(before.owner, owner) else { throw DriverCompoundNativeFault("OWNER_UNPROVEN") }
            var directPath: [DriverCompoundRawNode]?
            if ordinal == 0, plan.count >= 2, plan.first?.kind == .menuOpen, plan.last?.kind == .menuCommand,
               plan.dropFirst().dropLast().allSatisfy({ $0.kind == .menuExpand }) {
                let selectors = plan.map { $0.selector }
                directPath = try DriverCompoundResolver.unopened(selectors, bar: before.domain,
                    ownerProved: before.ownerProved, nodes: before.nodes)
                if directPath != nil {
                    transition = DriverCompoundTransition(kind: .menuDirect, selector: selectors.last!,
                        owner: recipient.root, value: nil, menuPath: selectors)
                    plan = [transition]; receipts = [DriverCompoundNativeReceipt(ordinal: 0)]
                }
            }
            let node: DriverCompoundRawNode
            if let path = directPath, let leaf = path.last {
                node = leaf
                guard path.allSatisfy({ local($0, transition, before) }) else { throw DriverCompoundNativeFault("BOUNDARY_REQUIRED") }
            } else {
                node = try DriverCompoundResolver.exact(transition.selector, container: before.domain,
                    complete: before.complete, ownerProved: before.ownerProved, nodes: before.nodes)
            }
            guard local(node, transition, before) else { throw DriverCompoundNativeFault("BOUNDARY_REQUIRED") }
            guard let contract = try providers.mechanism(transition.kind, node),
                  contracts.contains(where: { $0 === contract }), contract.kind == transition.kind,
                  contract.qualifies(before, node),
                  node.actions.contains(transition.kind.primitive == "press" ? "AXPress" : "AXSetValue") else {
                throw DriverCompoundNativeFault("UNSUPPORTED_TRANSITION")
            }
            let witness = DriverCompoundNativeWitness(execution: execution, ordinal: ordinal, recipient: recipient,
                before: before, transition: transition, node: node, contract: contract)
            prepared = witness; return witness
        } catch { stop(failure(error)); throw error }
    }
    func execute(_ grant: DriverCompoundNativeGrant) -> DriverCompoundNativeReceipt {
        // A duplicate returns only non-content receipt metadata. No second input.
        if grant.ordinal >= 0, grant.ordinal < receipts.count, receipts[grant.ordinal].attempts > 0 {
            return receipts[grant.ordinal]
        }
        let index = ordinal
        guard index < receipts.count else { return DriverCompoundNativeReceipt(ordinal: index, reason: "STALE_GRANT") }
        do {
            try check()
            guard let witness = prepared, !awaitingAck, grant.ordinal == index,
                  DriverCompoundRaw.equal(grant.execution, execution), DriverCompoundRaw.equal(grant.helper, recipient.helper),
                  !grant.opaque.isEmpty, !grants.contains(grant.opaque), grant.meaning == witness.before.meaning else {
                throw DriverCompoundNativeFault("STALE_GRANT")
            }
            let current = try read()
            guard current.epoch == witness.before.epoch, current.meaning == witness.before.meaning else {
                throw DriverCompoundNativeFault("WITNESS_CHANGED")
            }
            let node: DriverCompoundRawNode
            let inputPath: [DriverCompoundRawNode]
            if witness.transition.kind == .menuDirect, let selectors = witness.transition.menuPath {
                guard let path = try DriverCompoundResolver.unopened(selectors, bar: current.domain,
                    ownerProved: current.ownerProved, nodes: current.nodes), let leaf = path.last,
                    path.allSatisfy({ local($0, witness.transition, current) }) else {
                    throw DriverCompoundNativeFault("WITNESS_CHANGED")
                }
                node = leaf; inputPath = path
            } else {
                node = try DriverCompoundResolver.exact(witness.transition.selector, container: current.domain,
                    complete: current.complete, ownerProved: current.ownerProved, nodes: current.nodes)
                inputPath = [node]
            }
            guard DriverCompoundRaw.equal(node.token, witness.node.token),
                  try providers.mechanism(witness.transition.kind, node) === witness.contract,
                  witness.contract.qualifies(current, node),
                  node.actions.contains(witness.transition.kind.primitive == "press" ? "AXPress" : "AXSetValue") else {
                throw DriverCompoundNativeFault("UNSUPPORTED_TRANSITION")
            }
            guard local(node, witness.transition, current) else {
                throw DriverCompoundNativeFault("BOUNDARY_REQUIRED")
            }
            try check(); try providers.consume(grant, witness); grants.insert(grant.opaque)
            try check() // Re-sample person state after consumption, before the OS boundary.
            guard inputPath.allSatisfy({ local($0, witness.transition, current) }) else {
                throw DriverCompoundNativeFault("BOUNDARY_REQUIRED")
            }
            receipts[index].beforeRead = witness.before.read
            receipts[index].attempts = 1; receipts[index].delivery = "unknown"
            let delivery = try providers.perform(witness.transition.kind.primitive, node, witness.transition.value)
            guard ["sent-unverified", "sent-verified", "unknown", "not-sent"].contains(delivery) else {
                throw DriverCompoundNativeFault("INVALID_DELIVERY")
            }
            receipts[index].delivery = delivery
            guard ["sent-unverified", "sent-verified"].contains(delivery) else { throw DriverCompoundNativeFault("DELIVERY_UNRESOLVED") }
            try check(); guard try providers.settle() else { throw DriverCompoundNativeFault("UNSETTLED") }
            let after = try read()
            receipts[index].afterRead = after.read
            guard witness.contract.effect(witness.before, after, node, witness.transition.value) else {
                if witness.transition.kind == .menuDirect { nextObservation = after }
                throw DriverCompoundNativeFault(witness.transition.kind == .menuDirect ? "ACTION_UNCONFIRMED" : "EFFECT_UNVERIFIED")
            }
            if savePreparation, index == plan.count - 1, !providers.destinationVerified(after) {
                throw DriverCompoundNativeFault("DESTINATION_UNVERIFIED")
            }
            receipts[index].afterRead = after.read; receipts[index].observed = true
            if witness.transition.kind == .menuDirect {
                receipts[index].detail = "Pressed the menu item through Accessibility without opening the menu."
            }
            previous = after; priorToken = node.token; prepared = nil; awaitingAck = true
        } catch {
            let reason = failure(error); receipts[index].reason = reason; stop(reason)
            if let fault = error as? DriverCompoundNativeFault, fault.step != nil { receipts[index].detail = fault.description }
            if receipts[index].attempts > 0 { state = "uncertain" }
        }
        return receipts[index]
    }
    func acknowledge(_ index: Int) throws {
        do {
            try check()
            guard index == ordinal, awaitingAck, receipts[index].observed else { throw DriverCompoundNativeFault("STALE_ACKNOWLEDGMENT") }
            awaitingAck = false; ordinal += 1
            if ordinal == plan.count { state = savePreparation ? "prepared" : "completed" }
        } catch { stop(failure(error)); throw error }
    }
    var completedPrefix: Int { receipts.prefix(while: { $0.observed }).count }
    var unknownStep: Int? { receipts.first(where: { $0.attempts > 0 && !$0.observed })?.ordinal }
    var commitSent: Bool { false }
    var saved: Bool { false }
}
