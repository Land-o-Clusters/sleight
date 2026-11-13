import Foundation
import ApplicationServices

// One dispatcher owns strict text delivery. It has no board, snapshot, restore
// timer or recovery callback. Adapters supply explicit data only. Qualification
// belongs to the integrator, never to model arguments or AX settable alone.
enum DriverStrictTextPath: String {
    case selectedText = "ax-selected-text"
    case unicode = "unicode-pid"
}
struct DriverStrictText {
    static let refusal = "No qualified direct text operation supports this request. Nothing was sent. Read again and use typeText or setValue where the app supports it."
    static let controlRefusal = "Line breaks and tabs require a qualified selected-text insertion path. Unicode key events could submit a form or move focus. Nothing was sent."
    static func hasTextControls(_ text: String) -> Bool {
        text.unicodeScalars.contains { [9, 10, 13, 0x85, 0x2028, 0x2029].contains($0.value) }
    }
    static func unsupported(_ reason: String = refusal, controls: Bool = false) -> DriverFault {
        var fault = DriverFault("ACTION_UNSUPPORTED", reason)
        fault.disposition = ["delivery": "not-sent", "retry": "safe", "clipboard": "untouched", "textInput": controls ? "unsupported-controls" : "unsupported"]
        return fault
    }
    // validate -> resolve -> admit -> send once -> observe. There is no retry
    // edge, including after a lost acknowledgment or a failed observation.
    static func dispatch(_ request: DriverRequest, text: String, format: String,
                         resolve: () throws -> DriverStrictTextPath,
                         admit: (DriverStrictTextPath) throws -> Void,
                         send: (DriverStrictTextPath) throws -> Void,
                         observe: (DriverStrictTextPath) throws -> DriverObject) throws -> DriverObject {
        guard text.utf8.prefix(1_048_577).count <= 1_048_576 else { throw DriverFault("INVALID_PARAMS") }
        guard format == "text", !text.isEmpty,
              !text.unicodeScalars.contains(where: { $0.value < 32 && ![9, 10, 13, 0x85, 0x2028, 0x2029].contains($0.value) || $0.value == 127 }) else { throw unsupported() }
        try request.check()
        let path = try resolve()
        guard path != .unicode || !hasTextControls(text) else { throw unsupported(controlRefusal, controls: true) }
        try request.check()
        try admit(path)
        try request.check()
        try request.admitInput()
        do {
            try send(path)
            var result = try observe(path)
            result["clipboard"] = "untouched"
            result["textPath"] = path.rawValue
            result["semantics"] = "replace-selection-plain-text"
            return result
        } catch {
            // Once the adapter has been invoked, even a not-sent error is not
            // sufficient proof to replay a possibly partial Unicode sequence.
            var fault = error as? DriverFault ?? DriverFault("ACTION_UNCONFIRMED")
            fault.disposition["delivery"] = "unknown"; fault.disposition["retry"] = "read-first"
            fault.disposition.removeValue(forKey: "textInput")
            if fault.code == "PERSON_TOOK_OVER" { fault.disposition["personTookOver"] = true }
            fault.disposition["clipboard"] = "untouched"
            throw fault
        }
    }
    // Unicode payloads are explicit strings, chunked on scalar boundaries. No
    // menu command, focus activation, engine request or clipboard staging occurs.
    // Delivery remains unverified until the target's bounded AX observation.
    typealias UnicodePost = (Int32) -> Void
    typealias UnicodePrepare = ([String]) throws -> [UnicodePost]
    static func postUnicode(_ request: DriverRequest, pid: Int32, text: String,
                            prepare: UnicodePrepare = { try systemUnicode($0) }, checkpoint: () throws -> Void) throws {
        guard !hasTextControls(text) else { throw unsupported(controlRefusal, controls: true) }
        guard pid > 0, text.utf16.count <= 16_384 else { throw unsupported() }
        var chunks = [String](), chunk = ""
        for scalar in text.unicodeScalars {
            let next = String(scalar)
            if chunk.utf16.count + next.utf16.count > 32 { chunks.append(chunk); chunk = "" }
            chunk += next
        }
        if !chunk.isEmpty { chunks.append(chunk) }
        let posts = try prepare(chunks)
        guard posts.count == chunks.count else { throw DriverFault("ACTION_UNCONFIRMED") }
        for post in posts {
            try checkpoint(); try request.check()
            post(pid)
        }
    }
    // Construction prepares both edges before any post. A failed construction
    // cannot leave a lone keyDown. Each pair is sent once and never replayed.
    typealias EventSink = (CGEvent, Int32) -> Void
    static func systemUnicode(_ chunks: [String],
                              sink: @escaping EventSink = { event, pid in event.postToPid(pid) }) throws -> [UnicodePost] {
        guard chunks.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 32 && !hasTextControls($0) }) else { throw unsupported() }
        guard let source = CGEventSource(stateID: .privateState) else { throw DriverFault("ACTION_UNCONFIRMED") }
        return try chunks.map { chunk in
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { throw DriverFault("ACTION_UNCONFIRMED") }
            let units = Array(chunk.utf16)
            for event in [down, up] {
                event.flags = []; event.setIntegerValueField(.keyboardEventAutorepeat, value: 0)
                event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
            }
            return { pid in sink(down, pid); sink(up, pid) }
        }
    }
}
