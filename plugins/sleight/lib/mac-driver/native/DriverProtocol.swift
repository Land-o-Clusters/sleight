import Foundation
import Darwin

let driverProtocol = "sleight.driver/1"
// API 2 reads accept reuseIfUnchanged (0 seeds a proof). Read results carry
// reused: Bool; only a verified reuse keeps its previous readId and native map.
let driverLineLimit = 64 * 1024 * 1024
// Only the authenticated parent channel supplies this identity. Evaluated code
// has no renderer or lease fields in the parent safety request schema.
struct DriverRendererWireLease: Equatable {
    let pid: Int
    let processStart: String
    let bundleID: String
    let token: String
    static func envelope(_ params: DriverObject, read: Bool) throws -> DriverObject {
        let expected: Set<String> = read ? ["renderer", "lease"] : ["lease"]
        guard let args = params["args"] as? [Any], args.count == 1,
              let object = args[0] as? DriverObject,
              Set(object.keys) == expected,
              !read || driverBoolean(object["renderer"]) == true else { throw DriverFault("INVALID_PARAMS") }
        return object
    }
    init(_ value: Any?) throws {
        guard let value = value as? DriverObject,
              Set(value.keys) == ["pid", "processStart", "bundleId", "token"],
              let pid = driverInteger(value["pid"]), pid > 0, pid <= Int(Int32.max),
              let start = value["processStart"] as? String, start.utf8.count <= 64,
              start.range(of: "\\A[0-9]+[.][0-9]+\\z", options: .regularExpression) != nil,
              let bundle = value["bundleId"] as? String,
              bundle.range(of: "\\A[A-Za-z0-9._+-]{1,255}\\z", options: .regularExpression) != nil,
              let token = value["token"] as? String, token.utf8.count >= 1, token.utf8.count <= 128,
              token.range(of: "\\A[A-Za-z0-9-]+\\z", options: .regularExpression) != nil else {
            throw DriverFault("INVALID_PARAMS")
        }
        self.pid = pid; processStart = start; bundleID = bundle; self.token = token
    }
}

// Foundation accepts repeated object keys. Scan the JSON grammar before decoding,
// comparing decoded keys so escaped aliases cannot hide duplicates.
struct DriverJSON {
    let bytes: [UInt8]
    var offset = 0
    mutating func whitespace() { while offset < bytes.count && [9, 10, 13, 32].contains(bytes[offset]) { offset += 1 } }
    mutating func string() throws -> String {
        let start = offset
        guard offset < bytes.count, bytes[offset] == 34 else { throw DriverFault("DRIVER_PROTOCOL") }
        offset += 1
        while offset < bytes.count {
            let byte = bytes[offset]; offset += 1
            if byte == 92 { offset += 1; continue }
            if byte == 34 {
                let data = Data([91] + Array(bytes[start..<offset]) + [93])
                guard let array = try JSONSerialization.jsonObject(with: data) as? [String], let text = array.first else { throw DriverFault("DRIVER_PROTOCOL") }
                return text
            }
        }
        throw DriverFault("DRIVER_PROTOCOL")
    }
    mutating func value(_ depth: Int = 0) throws {
        guard depth < 128 else { throw DriverFault("DRIVER_PROTOCOL") }
        whitespace()
        guard offset < bytes.count else { throw DriverFault("DRIVER_PROTOCOL") }
        if bytes[offset] == 34 { _ = try string(); return }
        if bytes[offset] == 123 || bytes[offset] == 91 {
            let object = bytes[offset] == 123, end: UInt8 = object ? 125 : 93
            var keys = Set<String>(); offset += 1; whitespace()
            if offset < bytes.count, bytes[offset] == end { offset += 1; return }
            while true {
                whitespace()
                if object {
                    let key = try string()
                    guard keys.insert(key).inserted else { throw DriverFault("DRIVER_PROTOCOL") }
                    whitespace()
                    guard offset < bytes.count, bytes[offset] == 58 else { throw DriverFault("DRIVER_PROTOCOL") }
                    offset += 1
                }
                try value(depth + 1); whitespace()
                guard offset < bytes.count else { throw DriverFault("DRIVER_PROTOCOL") }
                let separator = bytes[offset]; offset += 1
                if separator == end { return }
                guard separator == 44 else { throw DriverFault("DRIVER_PROTOCOL") }
            }
        }
        let start = offset
        while offset < bytes.count && ![9, 10, 13, 32, 44, 93, 125].contains(bytes[offset]) { offset += 1 }
        guard offset > start else { throw DriverFault("DRIVER_PROTOCOL") }
    }
    static func decode(_ data: Data) throws -> DriverObject {
        guard String(data: data, encoding: .utf8) != nil else { throw DriverFault("DRIVER_PROTOCOL") }
        var parser = DriverJSON(bytes: Array(data)); try parser.value(); parser.whitespace()
        guard parser.offset == data.count, let object = try JSONSerialization.jsonObject(with: data) as? DriverObject else { throw DriverFault("DRIVER_PROTOCOL") }
        return object
    }
}

// Copies can be created before the watch exists. Share the holder so the first
// sample and every later sticky refusal belong to the entire logical request.
private final class DriverPersonRequestState {
    let token: Any?
    var watch: DriverPersonWatch?
    var waitedMs = 0.0
    var inputChecked = false
    var capMs: Int?
    var softDeadline: Double?
    init(token: Any?) { self.token = token }
}

private final class DriverInputControl {
    private let lock = NSLock()
    let ready = DispatchSemaphore(value: 0)
    private var cancelled = false, awaiting = false, allowed = false
    var authorized: Bool { lock.lock(); defer { lock.unlock() }; return allowed && !cancelled }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw DriverFault("PERSON_TOOK_OVER", "Input was cancelled; read again.") }
    }
    func cancel() { lock.lock(); cancelled = true; lock.unlock(); ready.signal() }
    func begin() throws { try check(); lock.lock(); awaiting = true; allowed = false; lock.unlock() }
    func answer(_ allow: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard awaiting else { return }
        awaiting = false
        if allow { allowed = true } else { cancelled = true }
        ready.signal()
    }
}

final class DriverRequest {
    let id: Int
    let method: String
    let params: DriverObject
    private let hardDeadline: Double
    var deadline: Double { min(hardDeadline, personState.softDeadline ?? hardDeadline) }
    let context: DriverObject?
    var walkDeadline: Double?
    private var sessionCheck: (() throws -> Void)?
    var stopCheck: (() throws -> Void)?
    var inputRelease: DriverInputRelease?
    private let personState: DriverPersonRequestState
    var personToken: Any? { personState.token }
    var personInputChecked: Bool {
        get { personState.inputChecked }
        set { personState.inputChecked = newValue }
    }
    var personWaitCapMs: Int? {
        get { personState.capMs }
        set { personState.capMs = newValue }
    }
    func beginPersonWait() { personState.softDeadline = hardDeadline - 0.150 }
    // Cancellation and checkpoint replies arrive on the authenticated stdin
    // reader, independently of the serial action queue.
    private let control: DriverInputControl
    var parentAdmission: (() throws -> Void)?
    func checkParentAdmission() throws { try parentAdmission?(); try control.check() }
    func cancelInput() { control.cancel() }
    func authorizeInput(_ allow: Bool) { control.answer(allow) }
    func awaitParentAdmission(_ notify: () -> Void) throws {
        try control.begin(); notify()
        while !control.authorized {
            try check()
            _ = control.ready.wait(timeout: .now() + 0.020)
        }
        try check()
    }
    var waitedForPersonMs: Double {
        get { personState.waitedMs }
        set { personState.waitedMs = newValue }
    }
    var personWatch: DriverPersonWatch? {
        get { personState.watch }
        set { personState.watch = newValue }
    }
    private final class InputAdmission {
        let lock = NSLock()
        var admitted = false
        var clipboardWatch: DriverClipboardWatch?
        var clipboardAdmission: DriverClipboardWatch.Admission?
        var clipboardFailure: DriverFault?
    }
    private let inputState: InputAdmission
    let actionEvent: DriverActionState?
    var inputAdmitted: Bool { inputState.lock.lock(); defer { inputState.lock.unlock() }; return inputState.admitted }
    func watchClipboard(_ watch: DriverClipboardWatch) {
        inputState.clipboardWatch = watch
    }
    func admitInput() throws {
        // The throwing read precedes both the delivery flag and any event. Copies
        // share the same baseline, including local tools and fallback presses.
        try check()
        try checkClipboardAdmission()
        do { try inputState.clipboardWatch?.admit(&inputState.clipboardAdmission) }
        catch let fault as DriverFault {
            inputState.clipboardFailure = fault
            throw fault
        }
        inputState.lock.lock(); inputState.admitted = true; inputState.lock.unlock()
        actionEvent?.admit()
    }
    func checkClipboardAdmission() throws {
        if let fault = inputState.clipboardFailure { throw fault }
    }
    func finishClipboard() throws -> Bool {
        guard inputAdmitted else { return false }
        return try inputState.clipboardWatch?.finish(inputState.clipboardAdmission) ?? false
    }
    // CPD1 is disabled. A future compound must use this between steps, with
    // copies sharing admission, before it can admit the next step.
    func checkClipboardStep(after step: Int) throws {
        guard let admission = inputState.clipboardAdmission,
              try inputState.clipboardWatch?.changed(admission) == true else { return }
        var fault = DriverFault("CLIPBOARD_CHANGED")
        fault.disposition = ["delivery": "sent-unverified", "retry": "read-first",
            "clipboardChanged": true, "step": step]
        throw fault
    }
    static let actionMethods = ["click", "doubleClick", "rightClick", "scroll", "drag", "typeText", "pressKey", "modifiers",
        "setValue", "selectText", "performSecondaryAction", "paste", "stuckMenuEscape"]
    var isAction: Bool { Self.actionMethods.contains(method) }
    var allowLocked: Bool { driverBoolean(params["allowLocked"]) ?? false }
    init(copying request: DriverRequest, method: String, params: DriverObject, reserving seconds: Double = 0) {
        id = request.id; self.method = method; self.params = params; hardDeadline = request.hardDeadline - max(0, seconds); context = request.context
        sessionCheck = request.sessionCheck
        stopCheck = request.stopCheck
        inputRelease = request.inputRelease
        personState = request.personState
        inputState = request.inputState
        actionEvent = request.actionEvent
        control = request.control; parentAdmission = request.parentAdmission
    }
    init(_ object: DriverObject, nonce: String, previous: Int) throws {
        let required = Set(["protocol", "platform", "nonce", "id", "method", "params", "deadline"])
        guard required.isSubset(of: Set(object.keys)), Set(object.keys).isSubset(of: required.union(["context"])),
              object["protocol"] as? String == driverProtocol, object["platform"] as? String == "darwin",
              object["nonce"] as? String == nonce, let id = driverInteger(object["id"]), id > previous,
              let method = object["method"] as? String, !method.isEmpty,
              let params = object["params"] as? DriverObject, let wall = driverInteger(object["deadline"]) else { throw DriverFault("DRIVER_PROTOCOL") }
        let remaining = Double(wall) - Date().timeIntervalSince1970 * 1000
        guard remaining <= 30_000 else { throw DriverFault("DRIVER_PROTOCOL") }
        if let raw = object["context"] {
            guard let context = raw as? DriverObject, Set(context.keys).isSubset(of: ["session", "turn", "call"]),
                  context.values.allSatisfy({ value in
                      guard let text = value as? String else { return false }
                      return text.unicodeScalars.count <= 128 && !text.unicodeScalars.contains(where: {
                          CharacterSet.controlCharacters.contains($0) || $0.value == 0x2028 || $0.value == 0x2029
                      })
                  }) else { throw DriverFault("DRIVER_PROTOCOL") }
            self.context = context
        } else { self.context = nil }
        self.id = id; self.method = method; self.params = params
        personState = DriverPersonRequestState(token: params["personToken"])
        inputState = InputAdmission()
        control = DriverInputControl()
        actionEvent = Self.actionMethods.contains(method) && DriverActionPipe.shared.enabled
            ? DriverActionState(id: id, method: method, args: params["args"] as? [Any] ?? []) : nil
        hardDeadline = ProcessInfo.processInfo.systemUptime + max(0, remaining) / 1000
    }
    var remaining: Double { max(0, deadline - ProcessInfo.processInfo.systemUptime) }
    var personWaitRemaining: Double { max(0, hardDeadline - ProcessInfo.processInfo.systemUptime) }
    func check() throws {
        try control.check()
        try stopCheck?()
        if remaining <= 0 {
            if personState.softDeadline != nil && !inputAdmitted { throw DriverFault("PERSON_TOOK_OVER") }
            throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true)
        }
        try sessionCheck?()
    }
    func pause(_ seconds: Double) throws {
        let end = ProcessInfo.processInfo.systemUptime + max(0, seconds)
        repeat {
            try check()
            let left = end - ProcessInfo.processInfo.systemUptime
            if left <= 0 { return }
            Thread.sleep(forTimeInterval: min(0.02, left, remaining))
        } while true
    }
    func withSessionCheck<T>(_ check: @escaping () throws -> Void, _ body: () throws -> T) rethrows -> T {
        let previous = sessionCheck; sessionCheck = check
        defer { sessionCheck = previous }
        return try body()
    }
    func keys(_ required: Set<String>, optional: Set<String> = []) throws {
        let common: Set<String> = isAction ? ["allowLocked", "read"] : ["allowLocked"]
        if let field = required.subtracting(params.keys).sorted().first { throw invalidParams(field) }
        if let field = Set(params.keys).subtracting(required.union(optional).union(common)).sorted().first { throw invalidParams(field) }
        if params["allowLocked"] != nil && driverBoolean(params["allowLocked"]) == nil { throw invalidParams("allowLocked") }
        if isAction, let read = params["read"] { guard ["full", "none"].contains(read as? String ?? "") else { throw invalidParams("read") } }
    }
    func invalidParams(_ field: String) -> DriverFault {
        var fault = DriverFault("INVALID_PARAMS")
        // Only fixed protocol names leave the helper. Unknown keys can contain
        // private data, so they receive the generic params name.
        let fields: Set<String> = ["windowId", "processStart", "selector", "depth", "budgetMs", "reuseIfUnchanged", "menuRequests", "args", "read", "allowLocked", "format", "scale"]
        fault.disposition["field"] = fields.contains(field) ? field : "params"
        return fault
    }
}

final class DriverRuntime {
    typealias Handler = (DriverRequest, DriverCore) throws -> DriverObject
    let core: DriverCore
    let nonce: String
    private let clipboardWatch: DriverClipboardWatch
    var onEOF: () -> Void = {}
    let userStop = DriverUserStop()
    let inputRelease = DriverInputRelease()
    var postReleaseEvent: (CGEvent, pid_t) throws -> Void = { event, pid in event.postToPid(pid) }
    var releaseHeldInput: () throws -> Void = {}
    private var handlers: [String: Handler] = [:]
    private let output = NSLock()
    private let controls = NSLock()
    private var requests: [Int: DriverRequest] = [:]
    private let queue = DispatchQueue(label: "sleight.driver.requests")
    init(core: DriverCore, nonce: String, clipboardCount: (() throws -> Int)? = nil,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime },
         personInputSince: ((Double) -> Bool)? = nil) {
        self.core = core; self.nonce = nonce
        let fixture = core.inventory.fixture != nil
        clipboardWatch = DriverClipboardWatch(count: clipboardCount ?? (fixture ? { 0 } : DriverClipboardWatch.systemCount),
            now: now, personInputSince: personInputSince ?? (fixture ? { _ in false } : DriverFocusProviders.system.personInputSince))
    }
    func handle(_ request: DriverRequest) throws -> DriverObject {
        request.watchClipboard(clipboardWatch)
        guard let handler = handlers[request.method] else { throw DriverFault("METHOD_NOT_FOUND") }
        let result = try handler(request, core)
        // Optional semantic/menu fallbacks cannot swallow a failed count read
        // and recast the refusal as a successful local-tool response.
        try request.checkClipboardAdmission()
        return result
    }
    func register(method: String, handler: @escaping Handler) {
        if DriverRequest.actionMethods.contains(method) { registerAction(method: method, handler: handler) }
        else { handlers[method] = handler }
    }
    // Input lanes must call request.admitInput() immediately before the first
    // post or AX mutation. A subsequent fault then cannot claim non-delivery.
    func registerAction(method: String, handler: @escaping Handler,
                        afterObservation: ((DriverRequest, DriverCore, DriverObject) throws -> DriverObject)? = nil) {
        handlers[method] = { [self] request, core in
            try request.keys(["windowId", "processStart", "readId", "args"], optional:
                Set(["read", "personToken"]).union(["click", "doubleClick", "rightClick"].contains(request.method) ? ["coordinateReadId"] : []))
            guard request.params["args"] is [Any] else { throw DriverFault("INVALID_PARAMS") }
            let fullRead = request.params["read"] as? String == "full"
            let settle = handlers["settle"]
            guard !fullRead || settle != nil else { throw DriverFault("ACTION_UNSUPPORTED") }
            var timing: DriverObject = ["sendMs": 0.0, "settleMs": 0.0, "postReadMs": 0.0]
            var phase: String? = "sendMs", phaseStart = ProcessInfo.processInfo.systemUptime
            func mark(_ next: String? = nil) {
                let at = ProcessInfo.processInfo.systemUptime
                if let phase = phase { timing[phase] = max(0, at - phaseStart) * 1000 }
                phase = next; phaseStart = at
            }
            do {
                let popupWindow = request.params["windowId"] as? String ?? ""
                let popupMap = core.maps[popupWindow]
                let popupSequence = core.person.inputSequence()
                var result = try handler(request, core)
                if request.inputAdmitted, let map = popupMap {
                    core.popups.began(map, window: popupWindow, sequence: popupSequence)
                }
                mark()
                // Menu actions can replace the window contents and element map.
                // Always return their following read, even for a tree-free caller.
                if fullRead || result["semantics"] as? String == "menu-accessibility", let settle = settle {
                    var binding: DriverObject = ["windowId": request.params["windowId"]!, "processStart": request.params["processStart"]!, "allowLocked": request.allowLocked]
                    var settleParams = binding; settleParams["afterReadId"] = request.params["readId"]
                    do {
                        mark("settleMs")
                        let settled: DriverObject
                        do { settled = try settle(DriverRequest(copying: request, method: "settle", params: settleParams), core) }
                        catch let fault as DriverFault where result["semantics"] as? String == "menu-accessibility" && !fault.unhealthy &&
                            ["STALE_ELEMENT", "IDENTITY_UNVERIFIED", "IDENTITY_CHANGED"].contains(fault.code) {
                            // Resizing can invalidate settle's geometry witness.
                            // Only the exact-identity post read below may recover;
                            // a failed rebind still returns observation unavailable.
                            settled = ["settled": false, "reason": "window-changed"]
                        }
                        binding.removeValue(forKey: "allowLocked")
                        mark("postReadMs")
                        let tree = try core.readTree(binding, request: request,
                            menuAfter: result["semantics"] as? String == "menu-accessibility" ? result["window"] as? DriverObject : nil)
                        mark()
                        result.merge(settled) { _, new in new }; result.merge(tree) { _, new in new }
                    } catch let fault as DriverFault where !fault.unhealthy &&
                        ["sent-verified", "sent-unverified"].contains(result["delivery"] as? String ?? "") &&
                        ["STALE_ELEMENT", "WINDOW_NOT_FOUND", "NO_WINDOWS_AVAILABLE", "IDENTITY_UNVERIFIED", "IDENTITY_CHANGED"].contains(fault.code) {
                        // The handler succeeded. Losing its window during observation
                        // cannot undo delivery or authorize a replay of the write.
                        result = result.filter { ["window", "delivery", "retry", "personTookOver", "focusChanged", "focusRestored", "fakeActiveMs", "charactersDelivered", "charactersPosted", "compositionBypassed", "textBeliefFallback", "menuFallbackCount", "valueVerified", "valueReadback", "valueReadbackLimit", "selectedRange", "matchCount", "semanticPress", "clipboardRestored", "clipboard", "textPath", "semantics"].contains($0.key) }
                        result["delivery"] = "sent-unverified"; result["retry"] = "read-first"; result["settled"] = false
                        result["observation"] = "unavailable"; result["observationError"] = fault.code
                        mark(); result["timing"] = timing
                        return result
                    }
                    if let afterObservation = afterObservation { result = try afterObservation(request, core, result) }
                } else {
                    result = result.filter { ["window", "delivery", "retry", "personTookOver", "settled", "focusChanged", "focusRestored", "fakeActiveMs", "charactersDelivered", "charactersPosted", "compositionBypassed", "textBeliefFallback", "menuFallbackCount", "valueVerified", "valueReadback", "valueReadbackLimit", "selectedRange", "matchCount", "semanticPress", "clipboardRestored", "clipboard", "textPath", "semantics"].contains($0.key) }
                }
                result["timing"] = timing
                return result
            } catch var fault as DriverFault {
                mark(); fault.disposition["timing"] = timing
                throw fault
            }
        }
    }
    func install(_ registrars: [(DriverRuntime) -> Void]) { for registrar in registrars { registrar(self) } }
    var methods: [String] { handlers.keys.sorted() }
    func replyEnvelope(_ request: DriverRequest, result: DriverObject? = nil, error: DriverFault? = nil,
                       checkClipboard: Bool = true) -> DriverObject {
        var result = result, error = error
        // A watchdog must never wait on the pasteboard server. Its unhealthy
        // reply already stops input and retires the helper.
        if checkClipboard {
            do {
                if try request.finishClipboard() {
                    if error != nil {
                        error!.disposition["clipboardChanged"] = true
                    } else {
                        if result == nil { result = [:] }
                        result!["clipboardChanged"] = true
                        // Local tools have their own result shapes. A completed
                        // admitted mutation is still delivery evidence when the
                        // tool omitted the ordinary action receipt.
                        if result!["delivery"] == nil {
                            result!["delivery"] = "sent-unverified"; result!["retry"] = "read-first"
                        }
                    }
                }
            } catch let fault as DriverFault {
                if error == nil { error = fault }
            } catch let unexpected {
                _ = unexpected
                if error == nil { error = DriverFault("DRIVER_INTERNAL", unhealthy: true) }
            }
        }
        if let cap = request.personWaitCapMs {
            if error != nil { error!.disposition["personWaitCapMs"] = cap }
            else { if result == nil { result = [:] }; result!["personWaitCapMs"] = cap }
        }
        if request.waitedForPersonMs > 0 {
            if error != nil { error!.disposition["waitedForPersonMs"] = Int(request.waitedForPersonMs.rounded(.up)) }
            else { if result == nil { result = [:] }; result!["waitedForPersonMs"] = Int(request.waitedForPersonMs.rounded(.up)) }
        }
        if var failure = error {
            if request.inputAdmitted || request.isAction, failure.disposition["delivery"] == nil {
                failure.disposition["delivery"] = request.inputAdmitted ? "unknown" : "not-sent"
                failure.disposition["retry"] = request.inputAdmitted ? "read-first" : "safe"
            }
            error = failure
        }
        var envelope: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": request.id, "ok": error == nil]
        if let error = error {
            envelope["error"] = error.json
            if let context = request.context { envelope["context"] = context }
        } else { envelope["result"] = result ?? [:] }
        return envelope
    }
    func reply(_ request: DriverRequest, result: DriverObject? = nil, error: DriverFault? = nil,
               checkClipboard: Bool = true, preparedEnvelope: DriverObject? = nil) {
        var envelope = preparedEnvelope ?? replyEnvelope(request, result: result, error: error, checkClipboard: checkClipboard)
        var eventError = error
        if let wireError = envelope["error"] as? DriverObject, let code = wireError["code"] as? String {
            var fault = DriverFault(code, unhealthy: wireError["unhealthy"] as? Bool ?? false)
            fault.disposition = wireError; eventError = fault
        }
        var data = try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .fragmentsAllowed])
        if data == nil || data!.count > driverLineLimit {
            envelope.removeValue(forKey: "result"); envelope["ok"] = false
            var fault = DriverFault("OUTPUT_LIMIT")
            if request.isAction { fault.disposition = ["delivery": request.inputAdmitted ? "unknown" : "not-sent", "retry": request.inputAdmitted ? "read-first" : "safe"] }
            eventError = fault
            envelope["error"] = fault.json
            if let context = request.context { envelope["context"] = context }
            data = try? JSONSerialization.data(withJSONObject: envelope)
        }
        request.actionEvent?.finish(result: envelope["result"] as? DriverObject, error: eventError, admitted: request.inputAdmitted)
        output.lock(); defer { output.unlock() }
        if var data = data { data.append(10); FileHandle.standardOutput.write(data) }
    }
    func serve() {
        var buffer = Data(), previous = 0
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty {
                if !buffer.isEmpty { _exit(65) }
                queue.sync {}
                let stopped = DispatchSemaphore(value: 0)
                DispatchQueue.global().async { self.onEOF(); stopped.signal() }
                _ = stopped.wait(timeout: .now() + 2)
                _exit(0)
            }
            buffer.append(chunk)
            while let lf = buffer.firstIndex(of: 10) {
                let line = buffer[..<lf]; guard line.count <= driverLineLimit else { _exit(65) }
                let request: DriverRequest
                var cancelBeforeInput = false
                var geometryTurn: String?
                do {
                    var object = try DriverJSON.decode(Data(line))
                    if object["control"] as? String == "geometry-end" {
                        guard Set(object.keys) == ["protocol", "platform", "nonce", "control", "turn"],
                              object["protocol"] as? String == driverProtocol, object["platform"] as? String == "darwin",
                              object["nonce"] as? String == nonce, let token = object["turn"] as? String,
                              token.count == 32, token.allSatisfy({ "0123456789abcdef".contains($0) }) else { _exit(65) }
                        queue.async { [self] in core.geometry.end(token) }
                        buffer.removeSubrange(...lf); continue
                    }
                    if let token = object.removeValue(forKey: "geometryTurn") {
                        guard let token = token as? String, token.count == 32,
                              token.allSatisfy({ "0123456789abcdef".contains($0) }) else { _exit(65) }
                        geometryTurn = token
                    }
                    if let command = object["control"] as? String, ["cancel", "allow", "deny"].contains(command) {
                        guard Set(object.keys) == ["protocol", "platform", "nonce", "id", "control"],
                              object["protocol"] as? String == driverProtocol, object["platform"] as? String == "darwin",
                              object["nonce"] as? String == nonce, let id = driverInteger(object["id"]), id > 0,
                              let command = object["control"] as? String, ["cancel", "allow", "deny"].contains(command) else { _exit(65) }
                        controls.lock(); let pending = requests[id]; controls.unlock()
                        if command == "cancel" { pending?.cancelInput() }
                        else { pending?.authorizeInput(command == "allow") }
                        buffer.removeSubrange(...lf); continue
                    }
                    if object["control"] as? String == "cancel-before-input" {
                        object.removeValue(forKey: "control"); cancelBeforeInput = true
                    } else if object["control"] != nil {
                        if object["control"] as? String == "release-posted" {
                            guard object["protocol"] as? String == driverProtocol, object["platform"] as? String == "darwin",
                                  object["nonce"] as? String == nonce,
                                  let token = object["token"] as? String, token.count == 32,
                                  token.allSatisfy({ "0123456789abcdef".contains($0) }),
                                  Set(object.keys) == ["protocol", "platform", "nonce", "control", "params", "token"] else { throw DriverFault("DRIVER_PROTOCOL") }
                            let posted: Bool
                            do { try releasePostedInput(object["params"]); posted = true } catch { posted = false }
                            output.lock()
                            let receipt: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                                "control": "released-posted", "token": token, "release": posted ? "posted" : "unconfirmed"]
                            if var bytes = try? JSONSerialization.data(withJSONObject: receipt) { bytes.append(10); FileHandle.standardOutput.write(bytes) }
                            output.unlock()
                            buffer.removeSubrange(...lf); continue
                        }
                        try userStop.receive(object, nonce: nonce)
                        if ["stop", "release"].contains(object["control"] as? String ?? "") {
                            let posted = inputRelease.stop()
                            let receipt: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                                "control": "released", "release": posted ? "posted" : "unconfirmed"]
                            output.lock()
                            if var bytes = try? JSONSerialization.data(withJSONObject: receipt) {
                                bytes.append(10); FileHandle.standardOutput.write(bytes)
                            }
                            output.unlock()
                        } else if !userStop.stopped { inputRelease.prompt() }
                        buffer.removeSubrange(...lf)
                        continue
                    }
                    request = try DriverRequest(object, nonce: nonce, previous: previous)
                    if cancelBeforeInput && !request.isAction && request.method != "localTool" { throw DriverFault("DRIVER_PROTOCOL") }
                }
                catch { _exit(65) }
                previous = request.id; buffer.removeSubrange(...lf)
                if request.remaining <= 0 {
                    reply(request, error: DriverFault("DEADLINE_EXCEEDED", unhealthy: true)); _exit(70)
                }
                controls.lock(); requests[request.id] = request; controls.unlock()
                request.parentAdmission = { [self, weak request] in
                    guard let request = request else { throw DriverFault("PERSON_TOOK_OVER") }
                    try request.awaitParentAdmission {
                        let frame: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                            "id": request.id, "checkpoint": "person-wait"]
                        output.lock(); defer { output.unlock() }
                        var data = try! JSONSerialization.data(withJSONObject: frame); data.append(10)
                        FileHandle.standardOutput.write(data)
                    }
                }
                if request.isAction || request.method == "localTool" {
                    let ticket = userStop.enqueue(request.id)
                    request.stopCheck = { try ticket.check() }
                    request.inputRelease = inputRelease
                    if cancelBeforeInput { userStop.cancel(request.id) }
                }
                // Watchdog starts at receipt, including time waiting in the serial queue.
                let finished = DriverCompletion()
                DispatchQueue.global().asyncAfter(deadline: .now() + request.remaining) { [self] in
                    if finished.finish() {
                        reply(request, error: DriverFault("DEADLINE_EXCEEDED", unhealthy: true), checkClipboard: false); _exit(70)
                    }
                }
                let capturedGeometryTurn = geometryTurn
                queue.async { [self] in
                    if let token = capturedGeometryTurn { core.geometry.begin(token) }
                    defer { controls.lock(); requests.removeValue(forKey: request.id); controls.unlock() }
                    var result: DriverObject?, failure: DriverFault?
                    let input = request.isAction || request.method == "localTool"
                    if input {
                        userStop.begin(request.id)
                    }
                    do {
                        try request.check()
                        result = try core.session.withRequestPower {
                            if let value = request.params["allowLocked"], driverBoolean(value) == nil { throw DriverFault("INVALID_PARAMS") }
                            if request.isAction {
                                guard request.params["read"] == nil || ["full", "none"].contains(request.params["read"] as? String ?? "") else { throw DriverFault("INVALID_PARAMS") }
                            }
                            let run = { [self] () throws -> DriverObject in
                                let value = try handle(request); try request.check(); return value
                            }
                            if driverSessionExemptMethods.contains(request.method) { return try run() }
                            return try core.session.withDesktopRequest(allowLocked: request.allowLocked) { check in
                                try request.withSessionCheck(check, run)
                            }
                        }
                    } catch let fault as DriverFault { failure = fault }
                    catch { failure = DriverFault("DRIVER_INTERNAL", unhealthy: true) }
                    if input {
                        if userStop.stopped {
                            // The input lanes unwind first. Persistent modifiers from
                            // earlier calls also belong to this helper, even on a drag.
                            var unhealthy = failure?.unhealthy ?? false
                            do { try releaseHeldInput() }
                            catch { unhealthy = true }
                            if !inputRelease.confirmed { unhealthy = true }
                            var stopped = DriverFault("USER_STOPPED", unhealthy: unhealthy)
                            stopped.disposition = (failure?.disposition ?? [:]).filter { !["code", "message", "next", "unhealthy"].contains($0.key) }
                            stopped.disposition["stopRelease"] = unhealthy ? "unconfirmed" : "posted"
                            failure = stopped; result = nil
                        }
                        userStop.end(request.id)
                    }
                    // Keep the watchdog armed through the final server read.
                    // Only the winner serializes output and finishes the event.
                    let envelope = replyEnvelope(request, result: result, error: failure)
                    if finished.finish() {
                        reply(request, result: result, error: failure, preparedEnvelope: envelope)
                        if (envelope["error"] as? DriverObject)?["unhealthy"] as? Bool == true { _exit(70) }
                    } else {
                        // The watchdog claimed the reply and owns process exit.
                        // Do not let EOF race that write and exit successfully.
                        DispatchSemaphore(value: 0).wait()
                    }
                }
            }
            if buffer.count > driverLineLimit { _exit(65) }
        }
    }
}

final class DriverCompletion {
    private let lock = NSLock()
    private var done = false
    func finish() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}
