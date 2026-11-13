import Foundation

// Inert compound primitives. Deliberately no registrar or system provider.
// Swift String == uses canonical equivalence. Compound selectors compare the
// original UTF-16 code units instead, without display cleanup or normalization.
enum DriverCompoundRaw {
    static func equal(_ lhs: String, _ rhs: String) -> Bool {
        lhs.utf16.elementsEqual(rhs.utf16)
    }
}

struct DriverCompoundSelector {
    let role: String
    let source: String
    let label: String
}

struct DriverCompoundRawNode {
    let token: String
    let parent: String
    let role: String
    let title: String?
    let description: String?
    var help: String? = nil
    var value: String? = nil
    let active: Bool
    let enabled: Bool
    let secure: Bool
    var childrenComplete: Bool = true
    var actions: [String] = []
}

enum DriverCompoundStop: String, Error {
    case incomplete = "OBSERVATION_INCOMPLETE"
    case ambiguous = "AMBIGUOUS_STEP"
    case missing = "STEP_NOT_FOUND"
    case disabled = "STEP_DISABLED"
    case secure = "SECURE_FIELD"
    case personUnknown = "PERSON_STATE_UNAVAILABLE"
    case takeover = "PERSON_TOOK_OVER"
    case modifiers = "PERSON_HOLDS_MODIFIER"
    case locked = "SCREEN_LOCKED"
    case secureInput = "SECURE_INPUT_ACTIVE"
    case foreground = "BACKGROUND_UNAVAILABLE"
}

enum DriverCompoundResolver {
    // AXMenuBar -> AXMenuBarItem -> AXMenu -> AXMenuItem, repeated for each
    // submenu. Dormant children count, including disabled twins. nil is absence
    // only, not permission to probe by pressing a parent after another failure.
    static func unopened(_ selectors: [DriverCompoundSelector], bar: String,
                         ownerProved: Bool, nodes: [DriverCompoundRawNode]) throws -> [DriverCompoundRawNode]? {
        guard ownerProved, nodes.allSatisfy({ $0.childrenComplete }) else { throw DriverCompoundStop.incomplete }
        guard let root = nodes.first(where: { DriverCompoundRaw.equal($0.token, bar) }),
              root.role == "AXMenuBar", root.active, !root.secure else { throw DriverCompoundStop.incomplete }
        guard !nodes.contains(where: { $0.role == "AXMenu" && $0.active }) else { throw DriverCompoundStop.foreground }
        var container = bar, path: [DriverCompoundRawNode] = []
        for (index, selector) in selectors.enumerated() {
            guard ["title", "description"].contains(selector.source) else { throw DriverCompoundStop.incomplete }
            let children = nodes.filter { DriverCompoundRaw.equal($0.parent, container) }
            let named = children.filter { node in
                let label = selector.source == "title" ? node.title : node.description
                return label.map { DriverCompoundRaw.equal($0, selector.label) } == true
            }
            let matches = named.filter { DriverCompoundRaw.equal($0.role, selector.role) }
            guard matches.count < 2 else { throw DriverCompoundStop.ambiguous }
            guard let node = matches.first else {
                guard named.isEmpty else { throw DriverCompoundStop.incomplete }
                return nil
            }
            guard !node.secure else { throw DriverCompoundStop.secure }
            path.append(node)
            let submenus = nodes.filter { DriverCompoundRaw.equal($0.parent, node.token) }
            if index == selectors.count - 1 {
                guard node.role == "AXMenuItem", submenus.isEmpty else { throw DriverCompoundStop.incomplete }
                return path // A stale disabled leaf may be tried exactly once.
            }
            guard node.enabled else { throw DriverCompoundStop.disabled }
            guard submenus.count < 2 else { throw DriverCompoundStop.ambiguous }
            guard let submenu = submenus.first else { return nil }
            guard submenu.role == "AXMenu", !submenu.secure else { throw DriverCompoundStop.incomplete }
            container = submenu.token
        }
        return nil
    }

    static func exact(_ selector: DriverCompoundSelector, container: String,
                      complete: Bool, ownerProved: Bool,
                      nodes: [DriverCompoundRawNode]) throws -> DriverCompoundRawNode {
        guard complete, ownerProved, ["title", "description"].contains(selector.source) else {
            throw DriverCompoundStop.incomplete
        }
        let matches = nodes.filter { node in
            let label = selector.source == "title" ? node.title : node.description
            return node.active && DriverCompoundRaw.equal(node.parent, container) &&
                DriverCompoundRaw.equal(node.role, selector.role) &&
                label.map { DriverCompoundRaw.equal($0, selector.label) } == true
        }
        guard matches.count < 2 else { throw DriverCompoundStop.ambiguous }
        guard let node = matches.first else { throw DriverCompoundStop.missing }
        guard !node.secure else { throw DriverCompoundStop.secure }
        guard node.enabled else { throw DriverCompoundStop.disabled }
        return node
    }
}

struct DriverCompoundPersonSample {
    let at: Double
    let lastInput: Double
    let sequence: UInt64
    let valid: Bool
    let targetScopedQuiet: Bool
    let heldModifiers: Bool
    let heldButtons: Bool
    let secureInput: Bool
    let locked: Bool
    let onConsole: Bool
    let focusChanged: Bool
}

// An embedding native transport must hold the same watch between requests.
// This global watch augments, and never resets, the target-scoped watch.
final class DriverCompoundGlobalWatch {
    private var previous: DriverCompoundPersonSample?
    private(set) var stopped: DriverCompoundStop?
    func check(_ current: DriverCompoundPersonSample) throws {
        if let reason = stopped { throw reason }
        do {
            guard current.valid, current.at.isFinite, current.lastInput.isFinite,
                  current.at >= 0, current.lastInput <= current.at else { throw DriverCompoundStop.personUnknown }
            guard !current.locked, current.onConsole else { throw DriverCompoundStop.locked }
            guard !current.secureInput else { throw DriverCompoundStop.secureInput }
            guard !current.heldModifiers, !current.heldButtons else { throw DriverCompoundStop.modifiers }
            guard !current.focusChanged else { throw DriverCompoundStop.foreground }
            guard current.targetScopedQuiet, current.at - current.lastInput >= 500 else { throw DriverCompoundStop.takeover }
            if let before = previous {
                guard current.at >= before.at, current.lastInput >= before.lastInput,
                      current.sequence >= before.sequence else { throw DriverCompoundStop.personUnknown }
                guard current.lastInput == before.lastInput, current.sequence == before.sequence else {
                    throw DriverCompoundStop.takeover
                }
            }
            previous = current
        } catch let reason as DriverCompoundStop {
            stopped = reason
            throw reason
        }
    }
}

// Same finite action families and normalization as compound/boundary.mjs.
// This pure classifier can only refuse. Reviewed mechanism contracts still
// decide whether a lexical non-boundary is a qualified local transition.
enum DriverCompoundBoundary {
    private static let confusables: [String: String] = [
        "а": "a",
        "α": "a",
        "ɑ": "a",
        "ᴀ": "a",
        "ⱥ": "a",
        "ʙ": "b",
        "ƀ": "b",
        "ƃ": "b",
        "с": "c",
        "ϲ": "c",
        "ⅽ": "c",
        "ᴄ": "c",
        "ȼ": "c",
        "ԁ": "d",
        "ⅾ": "d",
        "ᴅ": "d",
        "đ": "d",
        "ƌ": "d",
        "ð": "d",
        "е": "e",
        "ε": "e",
        "ϵ": "e",
        "ҽ": "e",
        "℮": "e",
        "ɛ": "e",
        "ᴇ": "e",
        "ɇ": "e",
        "ɘ": "e",
        "ե": "e",
        "է": "e",
        "ϝ": "f",
        "ꜰ": "f",
        "ɡ": "g",
        "ց": "g",
        "ɢ": "g",
        "ǥ": "g",
        "һ": "h",
        "հ": "h",
        "ʜ": "h",
        "ħ": "h",
        "і": "i",
        "ι": "i",
        "ӏ": "i",
        "ⅰ": "i",
        "ı": "i",
        "ɪ": "i",
        "ɨ": "i",
        "ј": "j",
        "ϳ": "j",
        "ᴊ": "j",
        "ɉ": "j",
        "κ": "k",
        "к": "k",
        "ᴋ": "k",
        "ⅼ": "l",
        "Ӏ": "l",
        "ʟ": "l",
        "ł": "l",
        "ƚ": "l",
        "ƛ": "l",
        "м": "m",
        "ⅿ": "m",
        "ᴍ": "m",
        "ո": "n",
        "п": "n",
        "ɴ": "n",
        "о": "o",
        "ο": "o",
        "օ": "o",
        "σ": "o",
        "ᴏ": "o",
        "ø": "o",
        "р": "p",
        "ρ": "p",
        "ᴘ": "p",
        "ք": "p",
        "ꞯ": "q",
        "г": "r",
        "ᴦ": "r",
        "ʀ": "r",
        "ɍ": "r",
        "ր": "r",
        "ѕ": "s",
        "ꜱ": "s",
        "տ": "s",
        "т": "t",
        "τ": "t",
        "ᴛ": "t",
        "ŧ": "t",
        "ⱦ": "t",
        "ʈ": "t",
        "υ": "u",
        "ս": "u",
        "ᴜ": "u",
        "ʉ": "u",
        "ν": "v",
        "ѵ": "v",
        "ⅴ": "v",
        "ᴠ": "v",
        "ԝ": "w",
        "ա": "w",
        "ᴡ": "w",
        "х": "x",
        "χ": "x",
        "ⅹ": "x",
        "у": "y",
        "γ": "y",
        "ʏ": "y",
        "ɏ": "y",
        "ᴢ": "z",
        "ƶ": "z",
        "ƻ": "z",
        "ƾ": "z"
    ]
    private static let pattern = #"(?<![\p{L}\p{N}])confirm(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])submit(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])send(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])authorize(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])authorise(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])approve(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])sign(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pay(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])payment(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])purchase(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])checkout(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])check out(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])subscribe(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])transfer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])withdraw(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])remove(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])erase(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])publish(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])post(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reply(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])share(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])place order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])place your order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])complete order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])order now(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])book(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])book now(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])buy(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])delete(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trash(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])save(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])finish(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])complete(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reserve(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])donate(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])upgrade(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])send money(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])charge(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirm order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirm purchase(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirm payment(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirm and pay(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])submit order(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])submit payment(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirmar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])enviar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autorizar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])aprobar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])firmar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pagar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pago(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])comprar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])finalizar compra(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])suscribirse(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])transferir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])retirar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])eliminar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])borrar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])publicar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])responder(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])compartir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pedir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])realizar pedido(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reservar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])guardar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])finalizar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])completar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])donar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])mejorar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])cobrar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirmer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])soumettre(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])envoyer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autoriser(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])approuver(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])signer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])payer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])paiement(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])acheter(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])passer commande(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])souscrire(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])s’abonner(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])s'abonner(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])transferer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])retirer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])supprimer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])effacer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])publier(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])repondre(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])partager(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])commander(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reserver(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])enregistrer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])sauvegarder(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])terminer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])finaliser(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])completer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])faire un don(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])mettre a niveau(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])facturer(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])bestatigen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])absenden(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])senden(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autorisieren(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])genehmigen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])zustimmen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])unterschreiben(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])signieren(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])bezahlen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])zahlen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])zahlung(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])kaufen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])zur kasse(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])abonnieren(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ubertragen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])uberweisen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])abheben(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])entfernen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])loschen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])veroffentlichen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])posten(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])antworten(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])teilen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])bestellen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])buchung abschliessen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])buchen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])speichern(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])beenden(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])fertigstellen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])abschliessen(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reservieren(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])spenden(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])upgraden(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])belasten(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confirmar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])submeter(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])enviar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autorizar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])aprovar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])assinar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pagar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pagamento(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])comprar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])finalizar compra(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])subscrever(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])assinar assinatura(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])transferir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])retirar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])sacar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])remover(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])apagar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])eliminar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])excluir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])publicar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])postar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])responder(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])partilhar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])compartilhar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])encomendar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])fazer pedido(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])reservar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])guardar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])salvar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])terminar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])concluir(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])completar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])doar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])atualizar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])cobrar(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])confermare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])conferma(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])inviare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])invia(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autorizzare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])autorizza(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])approvare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])approva(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])firmare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])firma(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pagare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])paga(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pagamento(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])acquistare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])acquista(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])procedi al pagamento(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])abbonarsi(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])abbonati(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trasferire(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])trasferisci(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])prelevare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])preleva(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])rimuovere(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])rimuovi(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])cancellare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])cancella(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])eliminare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])elimina(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pubblicare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])pubblica(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])rispondere(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])rispondi(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])condividere(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])condividi(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ordinare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])ordina(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])prenotare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])prenota(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])comprare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])compra(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])salvare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])salva(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])terminare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])termina(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])completare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])completa(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])riservare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])riserva(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])donare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])dona(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])aggiornare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])aggiorna(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])addebitare(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])addebita(?![\p{L}\p{N}])|確認|確定|送信|提出|承認|許可|認可|署名|支払う|支払い|支払|決済|購入|購読|登録|送金|振込|転送|引き出す|出金|削除|消去|公開|投稿|返信|共有|注文|予約|買う|保存|終了|完了|寄付|アッフクレート|請求|确认|確認|确定|確定|提交|发送|發送|傳送|授权|授權|批准|同意|签名|簽名|签署|簽署|支付|付款|购买|購買|结账|結帳|订阅|訂閱|转账|轉帳|轉賬|转移|轉移|提现|提現|提款|取款|移除|删除|刪除|擦除|清除|发布|發佈|發布|发表|發表|回复|回覆|分享|共享|下单|下單|订购|訂購|预订|預訂|预约|預約|买|買|保存|储存|儲存|结束|結束|完成|捐款|捐赠|捐贈|升级|升級|收费|收費|扣款|확인|확정|제출|보내기|전송|허가|인증|승인|서명|지불|결제|구매|구입|구독|이체|송금|전송하기|인출|출금|제거|삭제|지우기|발행|게시|답장|응답|공유|주문|예약|저장|종료|마침|완료|기부|업그레이드|청구|(?<![\p{L}\p{N}])(?:sign ?in|sign ?up|log ?in|create account|security|privacy|consent|allow|password|two factor|recovery|connected apps|overwrite|keep both|replace all)(?![\p{L}\p{N}])"#
    static func normalize(_ input: String) -> String {
        let folded = input.precomposedStringWithCompatibilityMapping.uppercased().lowercased()
            .replacingOccurrences(of: #"[\p{Cf}\p{Default_Ignorable_Code_Point}]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[\p{Z}\p{Pd}_\s\x{2212}]+"#, with: " ", options: .regularExpression)
            .decomposedStringWithCompatibilityMapping.lowercased()
            .replacingOccurrences(of: #"[\p{M}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]"#, with: "", options: .regularExpression)
        return folded.unicodeScalars.map { confusables[String($0)] ?? String($0) }.joined()
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    // JavaScript's English compatibility matcher uses ASCII word boundaries.
    private static let englishCompatibility = #"(?<![A-Za-z0-9_])(?:confirm|submit|send|authorize|authorise|approve|sign|pay|payment|purchase|checkout|check out|subscribe|transfer|withdraw|remove|erase|publish|post|reply|share|order|place order|place your order|complete order|order now|book|book now|buy|delete|trash|save|finish|complete|reserve|donate|upgrade|send money|charge|confirm order|confirm purchase|confirm payment|confirm and pay|submit order|submit payment)(?![A-Za-z0-9_])"#
    private static func mixedScriptWord(_ raw: String) -> Bool {
        let shown = raw.precomposedStringWithCompatibilityMapping
        let words = try! NSRegularExpression(pattern: #"[\p{L}\p{M}]+"#)
        return words.matches(in: shown, range: NSRange(shown.startIndex..., in: shown)).contains { match in
            let word = String(shown[Range(match.range, in: shown)!])
            return word.range(of: #"\p{script=Latin}"#, options: .regularExpression) != nil &&
                word.range(of: #"[\p{script=Greek}\p{script=Cyrillic}]"#, options: .regularExpression) != nil
        }
    }
    static func local(_ node: DriverCompoundRawNode, kind: DriverCompoundKind) -> Bool {
        guard !node.secure, ["AXMenuBarItem", "AXMenuItem", "AXPopUpButton", "AXTextField"].contains(node.role) else { return false }
        let labels = [node.title, node.description, node.help].compactMap { $0 }.filter { !$0.isEmpty }
        guard !labels.isEmpty else { return false }
        for raw in labels + (node.role != "AXTextField" ? [node.value].compactMap { $0 } : []) {
            let label = normalize(raw)
            guard !label.isEmpty else { return false }
            if [.saveOpen, .saveBasename].contains(kind),
               label.range(of: #"^save as(?:\.{3}|…)?$"#, options: .regularExpression) != nil { continue }
            if label.range(of: pattern, options: .regularExpression) != nil ||
                raw.range(of: englishCompatibility, options: [.regularExpression, .caseInsensitive]) != nil ||
                mixedScriptWord(raw) { return false }
            if label.range(of: #"\b(?:pay|card|cc-|credit|debit|cvv|cvc|expir|exp\b|mm/yy|iban|routing|account|ssn|social security|passw|passcode|pin|otp|secret|security code|billing|bank|secure)"#, options: .regularExpression) != nil { return false }
            // Currency figures are consequential even without a command verb.
            if label.range(of: #"\p{Sc}\s*[-+−]?\s*\d"#, options: .regularExpression) != nil { return false }
        }
        return true
    }
}
