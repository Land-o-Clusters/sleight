// Clipboard probe. Payloads stay in a private bank; published output contains hashes only.
import AppKit
import CryptoKit

struct Representation: Codable { let type: String; let data: Data }
struct Snapshot: Codable { let count: Int; let items: [[Representation]] }
let board = NSPasteboard.general
func snapshot() throws -> Snapshot {
    let count = board.changeCount
    let items = try (board.pasteboardItems ?? []).map { item in
        try item.types.map { type in
            guard let data = item.data(forType: type) else { throw NSError(domain: "clipboard", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unreadable representation: \(type.rawValue)"]) }
            return Representation(type: type.rawValue, data: data)
        }
    }
    guard count == board.changeCount else { throw NSError(domain: "clipboard", code: 2, userInfo: [NSLocalizedDescriptionKey: "Clipboard changed during snapshot"]) }
    return Snapshot(count: count, items: items)
}
func summary(_ s: Snapshot) -> [String: Any] {
    ["count": s.count, "items": s.items.map { $0.map { ["type": $0.type, "bytes": $0.data.count, "sha256": SHA256.hash(data: $0.data).map { String(format: "%02x", $0) }.joined()] as [String: Any] } }]
}
func write(_ items: [[Representation]]) throws {
    let objects = items.map { reps -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for rep in reps { item.setData(rep.data, forType: NSPasteboard.PasteboardType(rep.type)) }
        return item
    }
    board.clearContents()
    if !objects.isEmpty && !board.writeObjects(objects) { throw NSError(domain: "clipboard", code: 3, userInfo: [NSLocalizedDescriptionKey: "Clipboard write failed"]) }
}
func output(_ value: [String: Any]) throws { print(String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!) }
func rep(_ type: String, _ text: String) -> Representation { Representation(type: type, data: Data(text.utf8)) }
do {
    let args = CommandLine.arguments
    let op = args[1]
    switch op {
    case "inspect": try output(summary(snapshot()))
    case "save":
        let s = try snapshot()
        try JSONEncoder().encode(s).write(to: URL(fileURLWithPath: args[2]), options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: args[2])
        try output(summary(s))
    case "restore":
        guard board.changeCount == Int(args[3]) else { throw NSError(domain: "clipboard", code: 4, userInfo: [NSLocalizedDescriptionKey: "Clipboard ownership changed; leaving current contents"]) }
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
        try write(s.items); try output(summary(snapshot()))
    case "seed":
        var items: [[Representation]]
        switch args[2] {
        case "text": items = [[rep("public.utf8-plain-text", "SLEIGHT OLD TEXT")]]
        case "image":
            let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 8, bitsPerPixel: 32)!
            for x in 0..<2 { for y in 0..<2 { image.setColor(.red, atX: x, y: y) } }
            items = [[Representation(type: "public.png", data: image.representation(using: .png, properties: [:])!), Representation(type: "public.tiff", data: image.tiffRepresentation!)]]
        case "files": items = [[rep("public.file-url", URL(fileURLWithPath: args[3]).absoluteString)], [rep("public.file-url", URL(fileURLWithPath: args[4]).absoluteString)]]
        case "rich": items = [[rep("public.utf8-plain-text", "SLEIGHT RICH TEXT"), rep("public.rtf", "{\\rtf1\\ansi\\b SLEIGHT RICH TEXT}"), rep("public.html", "<b>SLEIGHT RICH TEXT</b>")]]
        case "empty": items = []
        default: throw NSError(domain: "clipboard", code: 5, userInfo: [NSLocalizedDescriptionKey: "Unknown seed"])
        }
        try write(items); try output(summary(snapshot()))
    case "watch":
        let done = NSLock(); var stopped = false
        DispatchQueue.global().async { _ = FileHandle.standardInput.readDataToEndOfFile(); done.lock(); stopped = true; done.unlock() }
        var events = [summary(try snapshot())]
        try output(["ready": true])
        fflush(stdout)
        var replaced = false
        while true {
            done.lock(); let stop = stopped; done.unlock()
            if stop { break }
            if board.changeCount != events.last?["count"] as? Int {
                events.append(summary(try snapshot()))
                if args.count > 2 && args[2] == "replace" && !replaced && board.string(forType: .string) == "SLEIGHT PASTE\n" {
                    try write([[rep("public.utf8-plain-text", "USER NEW COPY")]])
                    replaced = true
                    events.append(summary(try snapshot()))
                }
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
        events.append(summary(try snapshot()))
        try output(["events": events])
    default: throw NSError(domain: "clipboard", code: 6, userInfo: [NSLocalizedDescriptionKey: "Unknown operation"])
    }
} catch { try? output(["error": error.localizedDescription]); exit(1) }
