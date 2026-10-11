// Native AX window-created events provide references without inspecting any
// existing owner window. No Automation permission or browser profile override.
import AppKit
import ApplicationServices

var fixtureAppName = "browser"

struct FixtureError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

final class CreatedWindow<Element> {
    private var elements: [Element] = []
    private(set) var commandIssued = false
    var count: Int { elements.count }
    var observed: [Element] { elements }
    let equal: (Element, Element) -> Bool
    init(equal: @escaping (Element, Element) -> Bool) { self.equal = equal }
    func created(_ element: Element) {
        if !elements.contains(where: { equal($0, element) }) { elements.append(element) }
    }
    func unique() throws -> Element? {
        guard elements.count <= 1 else { throw FixtureError("Ambiguous new browser windows; no window inspected") }
        return elements.first
    }
    func requireEmpty() throws {
        guard elements.isEmpty else { throw FixtureError("Browser window created before fixture command; ownership refused") }
    }
    func beginCommand() throws { try requireEmpty(); commandIssued = true }
}

func fixtureCandidate<Element>(_ state: CreatedWindow<Element>, matches: (Element) throws -> Bool) throws -> Element? {
    guard let candidate = try state.unique(), try matches(candidate) else { return nil }
    return candidate
}

func retainCreated<Element>(_ state: CreatedWindow<Element>) throws -> Element {
    guard state.commandIssued, let candidate = try state.unique() else { throw FixtureError("Browser creation ownership unconfirmed") }
    return candidate
}

func retainedForRecovery<Element>(_ owned: Element?, state: CreatedWindow<Element>) -> Element? {
    guard state.count == 1, let owned, let candidate = try? state.unique(), state.equal(owned, candidate) else { return nil }
    return owned
}

func navigateRetained<Element>(_ state: CreatedWindow<Element>, ownerAway: Bool = false, blank: (Element) throws -> Bool,
    retain: (Element) -> Void, navigate: (Element) throws -> Void) throws {
    guard ownerAway else { throw FixtureError("\(fixtureAppName) blank-window navigation requires an explicit owner-away boundary") }
    guard state.commandIssued else { throw FixtureError("Browser creation command was not issued; navigation refused") }
    let candidate = try retainCreated(state)
    retain(candidate)
    guard try blank(candidate) else { throw FixtureError("New blank browser window unconfirmed") }
    try navigate(candidate)
}

func safariWindowCommand(_ titles: [String]) throws -> Int {
    let plain = titles.indices.filter { titles[$0] == "New Window" }
    if plain.count == 1 { return plain[0] }
    guard plain.isEmpty, let profile = titles.indices.first(where: {
        titles[$0].hasPrefix("New ") && titles[$0].hasSuffix(" Window") && titles[$0] != "New Private Window"
    }) else { throw FixtureError("\(fixtureAppName) new-window command unavailable or ambiguous") }
    return profile
}

func emit(_ object: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}

func controlCommand(_ data: Data?) -> String {
    guard let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let command = object["command"] as? String else { return "" }
    return command
}

func createdFixtureForRecovery<Element>(_ owned: Element?, state: CreatedWindow<Element>, matches: (Element) throws -> Bool) -> Element? {
    if let recovered = retainedForRecovery(owned, state: state) { return recovered }
    guard let candidate = try? state.unique(), (try? matches(candidate)) == true else { return nil }
    return candidate
}

func recoverRetained<Element>(_ window: Element?, appName: String = "browser", present: (Element) throws -> Bool, close: (Element) throws -> Void, wait: () -> Void) throws -> String {
    guard let window else { return "unconfirmed" }
    if try !present(window) { return "closed retained fixture" }
    try close(window)
    for _ in 0..<30 { wait(); if try !present(window) { return "closed retained fixture" } }
    throw FixtureError("Retained \(appName) fixture cleanup unconfirmed")
}

// Creation grants the one retained reference. Later creation events are evidence,
// not permission to close another window. AXRole can outlive a closed window;
// the caller confirms membership in AXWindows using reference equality only.
func cleanupCreatedWindow<Element>(_ owned: Element, observed: () -> [Element], appName: String,
    equal: (Element, Element) -> Bool, listed: (Element) throws -> Bool,
    details: (Element) throws -> (Int, Int), close: (Element) throws -> Void,
    wait: () -> Void, report: ([[String: Any]]) throws -> Void) throws {
    var windows = [owned]
    var records: [[String: Any]] = [["index": 0, "owned": true]]
    func refresh() {
        for window in observed() where !windows.contains(where: { equal($0, window) }) {
            records.append(["index": windows.count, "owned": false, "reason": "additional-created-window"])
            windows.append(window)
        }
    }
    var failure: Error?
    do {
        refresh()
        for index in windows.indices {
            records[index]["stillListed"] = try listed(windows[index])
            if index > 0 { records[index]["reason"] = "additional-created-window" }
        }
        if records[0]["stillListed"] as? Bool == true {
            let (sheets, dialogs) = try details(owned)
            records[0]["sheets"] = sheets; records[0]["dialogs"] = dialogs
            // Publish before acting too, so a parent watchdog preserves evidence.
            try report(records)
            do { try close(owned) }
            catch {
                records[0]["closeRefused"] = true
                records[0]["reason"] = "close-refused"
                throw error
            }
            for _ in 0..<30 {
                wait()
                records[0]["stillListed"] = try listed(owned)
                if records[0]["stillListed"] as? Bool == false { break }
            }
            if records[0]["stillListed"] as? Bool == true {
                records[0]["reason"] = "still-listed"
                throw FixtureError("window is still listed")
            }
        }
        records[0]["reason"] = "closed"
    } catch {
        failure = error
        refresh()
        records[0]["error"] = String(describing: error)
        if records[0]["reason"] == nil { records[0]["reason"] = "read-unconfirmed" }
        // A refusal may still have closed the reference. Record what is knowable.
        do { records[0]["stillListed"] = try listed(owned) }
        catch { records[0]["listingError"] = String(describing: error); records[0].removeValue(forKey: "stillListed") }
        if records[0]["stillListed"] as? Bool == true {
            do {
                let (sheets, dialogs) = try details(owned)
                records[0]["remainingSheets"] = sheets; records[0]["remainingDialogs"] = dialogs
            } catch { records[0]["detailsError"] = String(describing: error) }
        }
    }
    // Include events delivered during close, polling, or a refused action.
    // An arm-created second window is not ours. Leave it and stop the pass.
    refresh()
    for index in windows.indices.dropFirst() {
        do {
            records[index]["stillListed"] = try listed(windows[index])
            if records[index]["stillListed"] as? Bool == true {
                failure = failure ?? FixtureError("additional created window left open; ownership refused")
            }
        } catch {
            records[index]["listingError"] = String(describing: error)
            records[index].removeValue(forKey: "stillListed")
            failure = failure ?? error
        }
    }
    try report(records)
    if let failure { throw FixtureError("Owned \(appName) window cleanup unconfirmed: \(failure)") }
}

func shopSmokeHost(_ host: String) -> Bool {
    host == "www.target.com" || host == "www.bestbuy.com"
}

func allowedFixtureTarget(_ target: String) -> Bool {
    if target.hasPrefix("http://127.0.0.1:") { return true }
    guard let url = URLComponents(string: target), url.scheme == "https", shopSmokeHost(url.host ?? ""),
          url.user == nil, url.password == nil, url.path == "/" || url.path.isEmpty else { return false }
    return true
}

func fixtureURL(_ document: String, target: String, token: String) -> Bool {
    guard let expected = URLComponents(string: target), let current = URLComponents(string: document),
          current.user == nil, current.password == nil,
          !current.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return false }
    if shopSmokeHost(expected.host ?? "") {
        return expected.scheme == "https" && current.scheme == "https" && current.host == expected.host
    }
    guard expected.scheme == "http", expected.host == "127.0.0.1", expected.port != nil,
          current.scheme == expected.scheme, current.host == expected.host, current.port == expected.port,
          expected.path == "/\(token)/", current.path.hasPrefix(expected.path) else { return false }
    return true
}

func recoverFixture<Element>(_ window: Element?, target: String, token: String, allowBlank: Bool,
    appName: String = "browser", document: (Element) throws -> String, present: (Element) throws -> Bool, close: (Element) throws -> Void, wait: () -> Void) throws -> String {
    guard let window else { return "unconfirmed" }
    if try !present(window) { return "closed retained fixture" }
    let url = try document(window)
    guard (allowBlank && (url.isEmpty || url == "about:blank")) || fixtureURL(url, target: target, token: token) else { return "unconfirmed" }
    return try recoverRetained(window, appName: appName, present: present, close: close, wait: wait)
}

func safariAddressFields<Element>(_ window: Element, children: (Element) throws -> [Element],
    role: (Element) throws -> String, labels: (Element) throws -> [String], canNavigate: (Element) throws -> Bool) throws -> [Element] {
    var visited = 0
    func fields(_ element: Element, _ depth: Int, _ toolbar: Bool) throws -> [Element] {
        visited += 1
        guard depth > 0, visited <= 512 else { throw FixtureError("\(fixtureAppName) address search exceeded its bound") }
        let kind = try role(element), inToolbar = toolbar || kind == kAXToolbarRole
        // Start Page's web search is page content, never the browser's URL field.
        if kind == "AXWebArea" { return [] }
        var result: [Element] = []
        if inToolbar && [kAXTextFieldRole, kAXComboBoxRole].contains(kind) {
            let names = try labels(element).map { $0.lowercased() }
            let address = names.contains { ["smart search field", "address and search", "search or enter website name",
                "search or enter an address", "web_browser_address_and_search_field"].contains($0) }
            if address, try canNavigate(element) { result.append(element) }
        }
        for child in try children(element) { result += try fields(child, depth - 1, inToolbar) }
        return result
    }
    return try fields(window, 12, false)
}

func uniqueSafariAddress<Element>(_ candidates: [Element]) throws -> Element {
    guard candidates.count == 1 else { throw FixtureError("Retained \(fixtureAppName) address field unavailable or ambiguous") }
    return candidates[0]
}

// Safari exposes no AXDocument on its windows, so a navigated window is known by the run's nonce in
// its title, as before navigation (2026-10-09: every Safari cleanup refused its own form page).
func navigatedFixture(document: String, title: String, target: String, token: String) -> Bool {
    document.isEmpty ? title.contains(token) : fixtureURL(document, target: target, token: token)
}

func regression(_ scenario: String) throws {
    if scenario.hasPrefix("window-cleanup-") {
        let kind = String(scenario.dropFirst("window-cleanup-".count))
        var listed = ["owned", "owner"]
        var observed = kind == "second" ? ["owned", "second"] : ["owned"]
        if kind == "second" { listed.append("second") }
        var receipts: [[String: Any]] = [], actions: [String] = [], polls = 0
        let blockedDialog = ["system", "cancel-refused", "dialog-changed"].contains(kind)
        var dialogs = ["sheet", "dialog"].contains(kind) || blockedDialog ? ["attached"] : []
        var validations = 0, cancellations = 0, lateSheet = false
        var failure: Error?
        do {
            try cleanupCreatedWindow("owned", observed: { observed }, appName: "Example Browser", equal: ==,
                listed: { listed.contains($0) }, details: { window in
                    guard window == "owned" else { throw FixtureError("Unowned window contents inspected") }
                    return (kind == "sheet" || lateSheet ? 1 : 0, kind == "dialog" ? 1 : 0)
                }, close: { window in
                    guard window == "owned" else { throw FixtureError("Unowned window closed") }
                    try cancelOwnedDialogs(window, equal: ==, validate: {
                        validations += 1
                        if kind == "dialog-changed" { dialogs = ["replacement"] }
                    }, dialogs: { candidate in
                        guard candidate == "owned" else { throw FixtureError("Unowned dialogs read") }
                        return dialogs.map { ($0, kind != "system") }
                    }, cancel: { dialog in
                        cancellations += 1
                        if kind == "cancel-refused" { throw FixtureError("AXCancel refused") }
                        dialogs.removeAll { $0 == dialog }
                    }, wait: {})
                    let commands = ["Close Tab", "Close Window", "Close All Windows"]
                    let chosen = try closeWindowCommand(commands)
                    guard commands[chosen] == "Close Window", dialogs.isEmpty else { throw FixtureError("Tab or dialog left instead of closing owned window") }
                    actions.append("close-window")
                    if kind == "refused" { throw FixtureError("AX close refused: -25203") }
                    if kind == "late-sheet" { lateSheet = true }
                    if !["still-listed", "late-sheet"].contains(kind) { listed.removeAll { $0 == window } }
                }, wait: {
                    polls += 1
                    if kind == "late-second", polls == 1 { listed.append("second"); observed.append("second") }
                }, report: { receipts = $0 })
        } catch { failure = error }
        guard listed.contains("owner"), actions == (blockedDialog ? [] : ["close-window"]), let own = receipts.first,
              own["owned"] as? Bool == true else { throw FixtureError("Retained close escaped ownership or lost its receipt") }
        if blockedDialog {
            guard failure != nil, listed.contains("owned"), own["closeRefused"] as? Bool == true,
                  !dialogs.isEmpty, validations == (kind == "system" ? 0 : 1),
                  cancellations == (kind == "cancel-refused" ? 1 : 0) else { throw FixtureError("Unsafe dialog action admitted") }
        } else
        if ["tab", "sheet", "dialog"].contains(kind) {
            guard failure == nil, !listed.contains("owned"), own["stillListed"] as? Bool == false,
                  own["sheets"] as? Int == (kind == "sheet" ? 1 : 0),
                  own["dialogs"] as? Int == (kind == "dialog" ? 1 : 0) else { throw FixtureError("Owned window cleanup not confirmed") }
        } else {
            guard let failure, String(describing: failure).contains("Example Browser"),
                  !String(describing: failure).contains("Helium") else { throw FixtureError("Failure named the wrong app") }
            if ["second", "late-second"].contains(kind) {
                guard listed.contains("second"), receipts.count == 2,
                      receipts[1]["owned"] as? Bool == false,
                      receipts[1]["reason"] as? String == "additional-created-window" else { throw FixtureError("Second window hidden or closed") }
            } else {
                guard own["stillListed"] as? Bool == true,
                      own["reason"] as? String == (kind == "refused" ? "close-refused" : "still-listed"),
                      polls == (kind == "refused" ? 0 : 30) else { throw FixtureError("Close failure evidence missing") }
                if kind == "late-sheet", own["remainingSheets"] as? Int != 1 { throw FixtureError("Post-close sheet missing from receipt") }
            }
        }
    } else if scenario == "fixture-navigation" {
        guard navigatedFixture(document: "", title: "Personal — Form abc", target: "http://127.0.0.1:1234/abc/", token: "abc"),
              !navigatedFixture(document: "", title: "Personal — Start Page", target: "http://127.0.0.1:1234/abc/", token: "abc"),
              !navigatedFixture(document: "http://127.0.0.1:1234/other/", title: "Form abc", target: "http://127.0.0.1:1234/abc/", token: "abc")
        else { throw FixtureError("Title fallback without a document misjudged") }
        let target = "http://127.0.0.1:1234/abc/"
        for document in [target, target + "article/tidal?view=full#notes"] {
            guard fixtureURL(document, target: target, token: "abc") else { throw FixtureError("Fixture navigation refused") }
        }
        for document in ["https://127.0.0.1:1234/abc/", "http://127.0.0.1:4321/abc/", "http://example.test:1234/abc/",
            "http://127.0.0.1:1234/other/", "http://127.0.0.1:1234/abcd/", target + "../other/", target + "%2e%2e/other/", ""] {
            guard !fixtureURL(document, target: target, token: "abc") else { throw FixtureError("Foreign document admitted") }
        }
    } else if scenario == "safari-address" {
        let roles = ["window": kAXWindowRole, "toolbar": kAXToolbarRole, "url": kAXComboBoxRole,
            "page": "AXWebArea", "search": kAXTextFieldRole, "other": kAXTextFieldRole]
        var tree = ["window": ["toolbar", "page"], "toolbar": ["url"], "page": ["search"]]
        var names = ["url": ["Address and Search"], "search": ["Smart Search Field"], "other": ["Smart Search Field"]]
        var writable = true
        func find() throws -> [String] { try safariAddressFields("window", children: { tree[$0] ?? [] },
            role: { roles[$0] ?? "" }, labels: { names[$0] ?? [] }, canNavigate: { _ in writable }) }
        guard try uniqueSafariAddress(find()) == "url" else { throw FixtureError("Start Page search selected") }
        for label in ["Smart Search Field", "Search or enter website name", "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD"] {
            names["url"] = [label]
            guard try uniqueSafariAddress(find()) == "url" else { throw FixtureError("URL label refused") }
        }
        tree["toolbar"] = ["url", "other"]
        var refused = false
        do { _ = try uniqueSafariAddress(find()) } catch { refused = true }
        guard refused else { throw FixtureError("Ambiguous URL fields admitted") }
        tree["toolbar"] = ["url"]; writable = false
        refused = false
        do { _ = try uniqueSafariAddress(find()) } catch { refused = true }
        guard refused else { throw FixtureError("Non-navigable URL field admitted") }
        writable = true; names["url"] = ["Search the web"]
        guard try find().isEmpty else { throw FixtureError("Generic search field admitted") }
    } else if scenario == "safari-recovery" {
        let state = CreatedWindow<String>(equal: ==)
        try state.beginCommand(); state.created("created")
        var retained: String?, navigated = false, closed: [String] = []
        do { try navigateRetained(state, ownerAway: true, blank: { _ in false }, retain: { retained = $0 }, navigate: { _ in navigated = true }) } catch {}
        guard retained == "created", !navigated else { throw FixtureError("Rejected blank window lost its creation reference") }
        for url in ["", "about:blank", "http://127.0.0.1:1234/abc/article"] {
            var open = true
            let status = try recoverFixture(retained, target: "http://127.0.0.1:1234/abc/", token: "abc", allowBlank: true,
                document: { _ in url }, present: { _ in open }, close: { closed.append($0); open = false }, wait: {})
            guard status == "closed retained fixture" else { throw FixtureError("Created blank window leaked") }
        }
        let foreign = try recoverFixture(retained, target: "http://127.0.0.1:1234/abc/", token: "abc", allowBlank: true,
            document: { _ in "https://example.test/" }, present: { _ in true }, close: { _ in throw FixtureError("Foreign origin closed") }, wait: {})
        guard foreign == "unconfirmed", closed == ["created", "created", "created"] else { throw FixtureError("Creation recovery escaped its reference") }
        state.created("another")
        let ambiguous = try recoverFixture(retainedForRecovery(retained, state: state), target: "http://127.0.0.1:1234/abc/",
            token: "abc", allowBlank: true, document: { _ in "" }, present: { _ in true },
            close: { _ in throw FixtureError("Ambiguous creation closed") }, wait: {})
        guard ambiguous == "unconfirmed" else { throw FixtureError("Late ambiguity allowed recovery") }
        do { _ = try retainCreated(state); throw FixtureError("Ambiguous creation retained") } catch let error as FixtureError {
            guard error.description.contains("Ambiguous new browser") else { throw error }
        }
    } else if scenario == "control-command" {
        func cmd(_ text: String) -> String { controlCommand(text.data(using: .utf8)) }
        guard cmd("{\"command\":\"opened\",\"launched\":true}") == "opened",
              cmd("{\"command\":\"close\",\"launched\":true}") == "close",
              cmd("{\"command\":\"opened\"}") == "opened",
              cmd("{") == "",
              controlCommand(nil) == "" else { throw FixtureError("Control command rejected a boolean launched field") }
    } else if scenario == "timeout-recovery" {
        let state = CreatedWindow<String>(equal: ==)
        state.created("http://127.0.0.1:1234/abc/")
        var closed: [String] = []
        let recovered = createdFixtureForRecovery(nil as String?, state: state, matches: { $0.contains("abc") })
        let status = try recoverFixture(recovered, target: "http://127.0.0.1:1234/abc/", token: "abc", allowBlank: false,
            document: { $0 }, present: { _ in closed.isEmpty }, close: { closed.append($0) }, wait: {})
        guard status == "closed retained fixture", closed == ["http://127.0.0.1:1234/abc/"] else {
            throw FixtureError("Created fixture window leaked after a timed-out setup")
        }
        let foreign = CreatedWindow<String>(equal: ==)
        foreign.created("https://example.test/")
        guard createdFixtureForRecovery(nil as String?, state: foreign, matches: { $0.contains("abc") }) == nil else {
            throw FixtureError("Unmatched created window recovered")
        }
    } else if scenario == "shop-smoke" {
        guard shopSmokeHost("www.target.com"), shopSmokeHost("www.bestbuy.com"),
              !shopSmokeHost("target.com"), !shopSmokeHost("www.example.com") else {
            throw FixtureError("Shop smoke host allowlist misjudged")
        }
        guard allowedFixtureTarget("http://127.0.0.1:1234/abc/"),
              allowedFixtureTarget("https://www.target.com/"),
              allowedFixtureTarget("https://www.bestbuy.com/"),
              !allowedFixtureTarget("https://www.target.com/cart"),
              !allowedFixtureTarget("http://www.target.com/"),
              !allowedFixtureTarget("https://evil.test/") else {
            throw FixtureError("Shop smoke target allowlist misjudged")
        }
        let target = "https://www.target.com/"
        guard fixtureURL(target, target: target, token: "Target"),
              fixtureURL(target + "s?searchTerm=towels", target: target, token: "Target"),
              navigatedFixture(document: "", title: "Target : Expect More. Pay Less.", target: target, token: "Target"),
              !fixtureURL("https://www.bestbuy.com/", target: target, token: "Target"),
              !fixtureURL("http://www.target.com/", target: target, token: "Target"),
              !fixtureURL("https://evil.test/", target: target, token: "Target") else {
            throw FixtureError("Shop smoke fixture URL misjudged")
        }
    } else { throw FixtureError("Unknown browser regression") }
    try emit(["scenario": scenario, "passed": true])
}

// Pure regression: switching between two pre-existing windows cannot grant
// ownership. Only a creation event grants a candidate; two events refuse it.
func selfTest() throws {
    let state = CreatedWindow<String>(equal: ==)
    let ownerWindows = ["owner-a", "owner-b"]
    for _ in ownerWindows { guard try state.unique() == nil else { throw FixtureError("Existing window admitted") } }
    state.created("fixture")
    state.created("fixture")
    guard try state.unique() == "fixture" else { throw FixtureError("Delayed creation lost") }
    state.created("concurrent-new-window")
    var refused = false
    do { _ = try state.unique() } catch { refused = true }
    guard refused else { throw FixtureError("Ambiguous creation admitted") }
    let unrelated = CreatedWindow<String>(equal: ==)
    unrelated.created("owner-created-window")
    var retained: String?
    retained = try fixtureCandidate(unrelated, matches: { _ in false })
    guard retained == nil else { throw FixtureError("Unmatched window acquired") }
    do { retained = try fixtureCandidate(unrelated, matches: { _ in throw FixtureError("Read failed") }) } catch {}
    guard retained == nil else { throw FixtureError("Unreadable window acquired") }
    var open = true
    let recovery = try recoverRetained("fixture", present: { _ in open }, close: { value in
        guard value == "fixture" else { throw FixtureError("Another window closed") }; open = false
    }, wait: {})
    guard recovery == "closed retained fixture", try recoverRetained(nil as String?, present: { _ in true },
        close: { _ in throw FixtureError("Missing reference closed") }, wait: {}) == "unconfirmed" else { throw FixtureError("Retained recovery failed") }
    let fresh = CreatedWindow<String>(equal: ==)
    try fresh.beginCommand()
    fresh.created("fixture")
    var navigation: [String] = []
    retained = nil
    try navigateRetained(fresh, ownerAway: true, blank: { $0 == "fixture" }, retain: { retained = $0 }, navigate: {
        guard retained == $0 else { throw FixtureError("Navigation preceded retention") }; navigation.append($0)
    })
    guard navigation == ["fixture"] else { throw FixtureError("Owner window navigated") }
    for candidate in [unrelated, state] {
        do { try navigateRetained(candidate, ownerAway: true, blank: { _ in true }, retain: { _ in },
            navigate: { _ in navigation.append("unexpected") }) } catch {}
    }
    guard navigation == ["fixture"] else { throw FixtureError("Unproven window navigated") }
    guard try safariWindowCommand(["New Private Window", "New Personal Window", "New Work Window"]) == 1 else { throw FixtureError("Private profile command selected") }
    var ambiguousCommandRefused = false
    do { _ = try safariWindowCommand(["New Window", "New Window"]) } catch { ambiguousCommandRefused = true }
    guard ambiguousCommandRefused else { throw FixtureError("Ambiguous menu command admitted") }
    var preActionBlankRefused = false
    do { try unrelated.requireEmpty() } catch { preActionBlankRefused = true }
    guard preActionBlankRefused else { throw FixtureError("Pre-command owner blank window admitted") }
    let delayed = CreatedWindow<String>(equal: ==)
    try delayed.beginCommand()
    delayed.created("owner-created-before-delayed-fixture")
    var postCommandBlankRefused = false
    do { try navigateRetained(delayed, blank: { _ in true }, retain: { _ in }, navigate: { _ in navigation.append("owner") }) }
    catch { postCommandBlankRefused = true }
    delayed.created("delayed-fixture")
    guard postCommandBlankRefused, navigation == ["fixture"] else { throw FixtureError("Post-command owner blank window navigated") }
    try emit(["delayedFixture": true, "ambiguousCreationRefused": true, "existingWindowsRead": 0, "retainedRecovery": true, "unmatchedCreationUnowned": true, "retainedNavigation": true, "profileCommands": true, "preActionBlankRefused": true, "postCommandBlankRefused": true])
}

var freshSetup = false, createdFixture = false, actionTaken = false
var retryStarted: Date?
var retryWaitMs = 0

func read(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var value: CFTypeRef?
    var code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    while freshSetup && !createdFixture && (code == .cannotComplete || code == .attributeUnsupported) {
        retryStarted = retryStarted ?? Date()
        guard Date().timeIntervalSince(retryStarted!) < 15 else { break }
        let before = Date()
        wait()
        retryWaitMs = Int(Date().timeIntervalSince(retryStarted!) * 1000)
        try emit(["stage": "retry", "code": code.rawValue, "waitMs": Int(Date().timeIntervalSince(before) * 1000), "totalWaitMs": retryWaitMs])
        code = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    }
    if code == .attributeUnsupported || code == .noValue { return nil }
    guard code == .success else { throw FixtureError("AX fixture read failed: \(code.rawValue)") }
    return value
}
func text(_ element: AXUIElement, _ name: String) throws -> String {
    try read(element, name) as? String ?? ""
}
func present(_ window: AXUIElement) throws -> Bool {
    var role: CFTypeRef?
    let code = AXUIElementCopyAttributeValue(window, kAXRoleAttribute as CFString, &role)
    if code == .invalidUIElement { return false }
    guard code == .success else { throw FixtureError("AX fixture existence failed: \(code.rawValue)") }
    return role as? String == kAXWindowRole
}
func matches(_ window: AXUIElement, target: String, token: String, navigating: Bool = false) throws -> Bool {
    let document = try text(window, kAXDocumentAttribute)
    if navigating { return navigatedFixture(document: document, title: try text(window, kAXTitleAttribute), target: target, token: token) }
    if !document.isEmpty { return document == target || document.hasPrefix(target + "#") }
    return try text(window, kAXTitleAttribute).contains(token)
}
func wait() { CFRunLoopRunInMode(.defaultMode, 0.1, false) }

func children(_ element: AXUIElement) throws -> [AXUIElement] { try read(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func press(_ element: AXUIElement) throws {
    actionTaken = true
    try emit(["stage": "action", "actionTaken": true])
    let code = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard code == .success else { throw FixtureError("\(fixtureAppName) fixture press refused: \(code.rawValue)") }
}
func newSafariWindow(_ app: AXUIElement, beforeCreate: () throws -> Void) throws {
    guard let bar = try read(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { throw FixtureError("\(fixtureAppName) File menu unavailable") }
    let files = try children(bar as! AXUIElement).filter { try text($0, kAXTitleAttribute) == "File" }
    guard files.count == 1 else { throw FixtureError("\(fixtureAppName) File menu ambiguous") }
    var menus: [AXUIElement] = []
    do {
        try press(files[0])
        menus = try children(files[0]).filter { try text($0, kAXRoleAttribute) == kAXMenuRole }
        guard menus.count == 1 else { throw FixtureError("\(fixtureAppName) File menu contents unconfirmed") }
        let items = try children(menus[0])
        let index = try safariWindowCommand(items.map { try text($0, kAXTitleAttribute) })
        try beforeCreate()
        try press(items[index])
    } catch {
        guard AXUIElementPerformAction(menus.first ?? files[0], "AXCancel" as CFString) == .success else { throw FixtureError("\(fixtureAppName) failed-menu cancellation unconfirmed: \(error)") }
        try emit(["stage": "menu-cancel", "menuCancelled": true, "menuCancelMethod": "AXCancel"])
        throw error
    }
}
func blankSafariWindow(_ window: AXUIElement) throws -> Bool {
    let document = try text(window, kAXDocumentAttribute), title = try text(window, kAXTitleAttribute)
    // With Safari profiles a new window's Start Page is titled "<Profile> — Start Page" (2026-10-09).
    return (document.isEmpty || document == "about:blank") &&
        (title.isEmpty || title == "Start Page" || title.hasSuffix(" — Start Page") || title == "Untitled")
}
func navigateSafariWindow(_ window: AXUIElement, target: String) throws {
    let addresses = try safariAddressFields(window, children: children, role: { try text($0, kAXRoleAttribute) },
        labels: { element in try [kAXDescriptionAttribute, kAXTitleAttribute, kAXHelpAttribute,
            kAXPlaceholderValueAttribute, kAXIdentifierAttribute].map { try text(element, $0) } }, canNavigate: { element in
            var settable: DarwinBoolean = false
            var actions: CFArray?
            return AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue &&
                AXUIElementCopyActionNames(element, &actions) == .success && (actions as? [String] ?? []).contains(kAXConfirmAction)
        })
    try emit(["stage": "navigation", "navigation": ["addressFieldCount": addresses.count]])
    let field = try uniqueSafariAddress(addresses)
    guard try blankSafariWindow(window) else { throw FixtureError("New \(fixtureAppName) window changed before navigation") }
    actionTaken = true
    guard AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString, target as CFString) == .success,
          AXUIElementPerformAction(field, kAXConfirmAction as CFString) == .success else { throw FixtureError("Retained \(fixtureAppName) navigation failed") }
}

func closeWindowCommand(_ titles: [String]) throws -> Int {
    let candidates = titles.indices.filter { titles[$0] == "Close Window" }
    guard candidates.count == 1 else { throw FixtureError("Close Window command unavailable or ambiguous") }
    return candidates[0]
}

func cancelOwnedDialogs<Element>(_ window: Element, equal: (Element, Element) -> Bool,
    validate: () throws -> Void, dialogs: (Element) throws -> [(Element, Bool)],
    cancel: (Element) throws -> Void, wait: () -> Void) throws {
    for (dialog, safe) in try dialogs(window) {
        guard safe else { throw FixtureError("Owned window has an access or system dialog; cancellation refused") }
        try validate()
        guard try dialogs(window).contains(where: { equal($0.0, dialog) && $0.1 }) else {
            throw FixtureError("Owned dialog changed; cancellation refused")
        }
        try cancel(dialog)
    }
    for _ in 0..<30 { if try dialogs(window).isEmpty { return }; wait() }
    guard try dialogs(window).isEmpty else { throw FixtureError("Owned window sheet or dialog remains") }
}

func ownedDialogs(_ window: AXUIElement) throws -> [(AXUIElement, String)] {
    var found: [(AXUIElement, String)] = [], visited = 0
    func visit(_ node: AXUIElement, _ depth: Int) throws {
        if found.contains(where: { CFEqual($0.0, node) }) { return }
        visited += 1
        guard depth > 0, visited <= 512 else { throw FixtureError("Owned dialog search exceeded its bound") }
        let role = try text(node, kAXRoleAttribute), subrole = try text(node, kAXSubroleAttribute)
        if role == "AXWebArea" { return }
        if role == kAXSheetRole || ["AXDialog", "AXSystemDialog"].contains(subrole) {
            found.append((node, subrole == "AXSystemDialog" ? subrole : role == kAXSheetRole ? role : subrole))
        }
        for child in try children(node) { try visit(child, depth - 1) }
    }
    for sheet in try read(window, "AXSheets") as? [AXUIElement] ?? [] { try visit(sheet, 12) }
    for child in try children(window) { try visit(child, 12) }
    return found
}

// Only AXCancel on an attached app dialog is allowed. No button choice, key
// event, URL lookup, title-based ownership, or action on a system prompt.
func closeWholeWindow(_ window: AXUIElement, app: AXUIElement, validate: () throws -> Void) throws {
    try validate()
    try cancelOwnedDialogs(window, equal: { CFEqual($0, $1) }, validate: validate, dialogs: { window in
        try ownedDialogs(window).map { dialog, kind in
            let title = try text(dialog, kAXTitleAttribute).lowercased()
            return (dialog, kind != "AXSystemDialog" && !["permission", "would like", "allow access", "grant access"].contains(where: { title.contains($0) }))
        }
    }, cancel: { dialog in
        guard AXUIElementPerformAction(dialog, kAXCancelAction as CFString) == .success else { throw FixtureError("Owned window dialog cancellation refused") }
    }, wait: wait)
    // Direct the app's menu at the retained window, even when the arm selected
    // another window. Revalidate focus immediately before each menu press.
    try validate()
    func focused() throws -> Bool {
        guard let current = try read(app, kAXFocusedWindowAttribute) else { return false }
        return CFEqual(current, window)
    }
    if try !focused() {
        guard AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue) == .success else {
            throw FixtureError("Retained window focus refused")
        }
    }
    func beforePress() throws {
        try validate()
        guard try focused() else { throw FixtureError("Owned window lost focus; close refused") }
    }
    guard let bar = try read(app, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { throw FixtureError("File menu unavailable") }
    let files = try children(bar as! AXUIElement).filter { try text($0, kAXTitleAttribute) == "File" }
    guard files.count == 1 else { throw FixtureError("File menu ambiguous") }
    var menu: AXUIElement?
    do {
        try beforePress(); try press(files[0])
        let menus = try children(files[0]).filter { try text($0, kAXRoleAttribute) == kAXMenuRole }
        guard menus.count == 1 else { throw FixtureError("File menu contents unconfirmed") }
        menu = menus[0]
        let items = try children(menus[0])
        let item = items[try closeWindowCommand(items.map { try text($0, kAXTitleAttribute) })]
        guard try read(item, kAXEnabledAttribute) as? Bool == true else { throw FixtureError("Close Window command disabled") }
        try beforePress(); try press(item)
    } catch {
        if let menu {
            guard AXUIElementPerformAction(menu, kAXCancelAction as CFString) == .success else {
                throw FixtureError("Close menu cancellation unconfirmed: \(error)")
            }
        }
        throw error
    }
}

func recoverSetup(_ owned: AXUIElement?, target: String, token: String, safari: Bool, appName: String) throws -> String {
    try recoverFixture(owned, target: target, token: token, allowBlank: safari, appName: appName,
        document: { try text($0, kAXDocumentAttribute) }, present: present, close: { window in
        guard let button = try read(window, kAXCloseButtonAttribute), CFGetTypeID(button) == AXUIElementGetTypeID(),
              AXUIElementPerformAction(button as! AXUIElement, kAXPressAction as CFString) == .success else {
            throw FixtureError("Retained \(appName) fixture close failed")
        }
    }, wait: wait)
}

func fixture(_ argument: String) throws {
    guard let data = argument.data(using: .utf8),
          let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let bundle = request["bundle"] as? String, !bundle.isEmpty,
          let appName = request["app"] as? String, !appName.isEmpty,
          let launch = request["fixtureLaunch"] as? String, ["retained-url", "new-instance"].contains(launch),
          request["mode"] as? String == "window",
          let target = request["target"] as? String, allowedFixtureTarget(target),
          let token = request["token"] as? String, !token.isEmpty,
          let control = request["control"] as? String else { throw FixtureError("Invalid created-window fixture request") }
    guard AXIsProcessTrusted() else { throw FixtureError("Accessibility unavailable; \(appName) fixture not opened") }
    fixtureAppName = appName
    let safari = launch == "retained-url"
    guard !safari || request["ownerAway"] as? Bool == true else { throw FixtureError("\(appName) setup requires an explicit owner-away boundary") }
    if let host = URLComponents(string: target)?.host, shopSmokeHost(host) {
        guard safari else { throw FixtureError("Shop smoke fixtures require retained-url setup") }
    }
    var applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    let running = !applications.isEmpty
    if safari {
        try emit(["stage": "launch", "running": running])
        var reportedPID: pid_t?
        for _ in 0..<100 {
            applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            if applications.count == 1, reportedPID == nil {
                reportedPID = applications[0].processIdentifier
                try emit(["stage": "launched", "pid": reportedPID!])
            }
            if applications.count == 1 && applications[0].isFinishedLaunching { break }
            wait()
        }
    }
    guard applications.count == 1, applications[0].isFinishedLaunching else {
        try emit(["stage": "untouched"])
        throw FixtureError("\(appName) must be running with one real profile process")
    }
    let pid = applications[0].processIdentifier
    try emit(["stage": "identified", "running": running, "pid": pid])
    freshSetup = safari && !running
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var setup = true
    var owned: AXUIElement?
    let created = CreatedWindow<AXUIElement>(equal: { CFEqual($0, $1) })
    do {
    var observer: AXObserver?
    let callback: AXObserverCallback = { _, element, notification, refcon in
        guard notification as String == kAXWindowCreatedNotification, let refcon else { return }
        createdFixture = true
        Unmanaged<CreatedWindow<AXUIElement>>.fromOpaque(refcon).takeUnretainedValue().created(element)
    }
    guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
        throw FixtureError("\(appName) window-created observer unavailable")
    }
    let refcon = Unmanaged.passUnretained(created).toOpaque()
    guard AXObserverAddNotification(observer, app, kAXWindowCreatedNotification as CFString, refcon) == .success else {
        throw FixtureError("\(appName) window-created notification unavailable")
    }
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
    defer {
        AXObserverRemoveNotification(observer, app, kAXWindowCreatedNotification as CFString)
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
        withExtendedLifetime(created) {}
    }
    func command() -> String { controlCommand(FileManager.default.contents(atPath: control)) }
    func sameProcess() throws -> Bool {
        guard let current = NSRunningApplication(processIdentifier: pid) else { return false }
        guard current.bundleIdentifier == bundle else { throw FixtureError("Browser fixture process changed") }
        return !current.isTerminated
    }
    try emit(["stage": "armed", "running": running, "pid": pid])
    while command() != "opened" {
        if command() == "close" { throw FixtureError("\(appName) opening cancelled before identity recorded") }
        wait()
    }
    if safari {
        try newSafariWindow(app, beforeCreate: { wait(); try created.beginCommand() })
        for _ in 0..<30 {
            wait()
            if try created.unique() != nil { break }
        }
        wait()
        // Retain before metadata reads or blank-page validation can fail. Only
        // the unique event after our creation command supplies this reference.
        owned = try retainCreated(created)
        var creation: [String: Any] = ["count": created.count]
        if let candidate = try created.unique() {
            let document = try text(candidate, kAXDocumentAttribute), title = try text(candidate, kAXTitleAttribute)
            creation["blank"] = try blankSafariWindow(candidate)
            creation["documentScheme"] = document.isEmpty ? "absent" : String(document.prefix(while: { $0 != ":" }).prefix(32))
            creation["titleKind"] = title.isEmpty ? "empty" : (title == "Start Page" || title.hasSuffix(" — Start Page")) ? "start-page" : title == "Untitled" ? "untitled" : "other"
        }
        try emit(["stage": "creation", "creation": creation])
        try navigateRetained(created, ownerAway: request["ownerAway"] as? Bool == true, blank: blankSafariWindow, retain: { owned = $0; createdFixture = true },
            navigate: { try navigateSafariWindow($0, target: target) })
    }
    var ready = false
    for _ in 0..<200 {
        if command() == "close" { throw FixtureError("\(appName) opening cancelled before identity recorded") }
        guard try sameProcess() else { throw FixtureError("\(appName) exited during fixture setup") }
        // Pump first so all queued creation events are checked for ambiguity.
        wait()
        if !safari { owned = nil }
        if let candidate = try fixtureCandidate(created, matches: { try matches($0, target: target, token: token) }) {
            owned = candidate; ready = true; break
        }
    }
    guard ready, let owned else { throw FixtureError("New \(appName) fixture identity unconfirmed") }
    try emit(["stage": "ready", "pid": pid, "fresh": !running, "totalWaitMs": retryWaitMs])
    setup = false
    freshSetup = false
    while command() != "close" { wait() }
    wait() // Drain late creation events before recording cleanup's window set.
    func listed(_ window: AXUIElement) throws -> Bool {
        guard try sameProcess() else { return false }
        guard let windows = try read(app, kAXWindowsAttribute) as? [AXUIElement] else { throw FixtureError("Window listing unavailable") }
        return windows.contains { CFEqual($0, window) }
    }
    func validate() throws {
        var windowPID: pid_t = 0
        guard try sameProcess(), AXUIElementGetPid(owned, &windowPID) == .success, windowPID == pid,
              try listed(owned) else { throw FixtureError("Retained window process or listing changed; close refused") }
    }
    try cleanupCreatedWindow(owned, observed: { created.observed }, appName: appName, equal: { CFEqual($0, $1) },
        listed: listed, details: { window in
            let dialogs = try ownedDialogs(window)
            return (dialogs.filter { $0.1 == kAXSheetRole }.count, dialogs.filter { $0.1 != kAXSheetRole }.count)
        }, close: { window in try closeWholeWindow(window, app: app, validate: validate) }, wait: wait,
        report: { try emit(["stage": "window-cleanup", "windows": $0]) })
    try emit(["stage": "closed"])
    } catch {
        if setup {
            freshSetup = false
            var event: [String: Any] = ["stage": "setup-failure", "fresh": !running, "actionTaken": actionTaken, "totalWaitMs": retryWaitMs, "pid": pid]
            do {
                if let current = NSRunningApplication(processIdentifier: pid), !current.isTerminated {
                    guard current.bundleIdentifier == bundle else { throw FixtureError("Browser process changed before recovery") }
                    event["cleanup"] = try recoverSetup(createdFixtureForRecovery(owned, state: created, matches: {
                        (try? matches($0, target: target, token: token)) == true
                            || (try? matches($0, target: target, token: token, navigating: true)) == true
                    }), target: target, token: token, safari: safari, appName: appName)
                } else { event["cleanup"] = owned == nil ? "unconfirmed" : "closed retained fixture" }
            } catch { event["cleanupError"] = String(describing: error) }
            try emit(event)
        }
        throw error
    }
}

do {
    if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--self-test" { try selfTest() }
    else if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--self-test" { try regression(CommandLine.arguments[2]) }
    else {
        guard CommandLine.arguments.count == 2 else { throw FixtureError("One fixture request required") }
        try fixture(CommandLine.arguments[1])
    }
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
