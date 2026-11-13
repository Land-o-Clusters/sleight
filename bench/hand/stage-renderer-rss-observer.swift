// Linked only into the renderer RSS diagnostic build. No timers, windows, input, traces or fixture behavior.
// One snapshot is requested through private fd 3 and returned through fd 4 on the AppKit thread.
import Foundation
import Darwin

func rendererRSSSnapshot(_ host: HandHost) -> [String: Any] {
    let cache = host.perch.loaded?.stage.counters
    let visibility = host.perch.diagnostics
    return ["pid": getpid(), "loaded": host.perch.loaded != nil,
        "cacheBytes": cache?["cacheBytes"] ?? 0, "residentStrips": cache?["residentStrips"] ?? 0,
        "pending": cache?["pending"] ?? 0, "shown": visibility["shown"] ?? false,
        "size": visibility["size"] ?? NSNull(), "requestedSize": host.perch.stage.options.size]
}
var rendererRSSObserver: DispatchSourceRead?
var rendererRSSInput = Data()
func rendererRSSInstallObserver(_ host: HandHost, endOnEOF: Bool = false) {
    guard fcntl(3, F_GETFD) != -1, fcntl(4, F_GETFD) != -1 else { exit(64) }
    let source = DispatchSource.makeReadSource(fileDescriptor: 3, queue: .main)
    source.setEventHandler { [weak host] in
        var bytes = [UInt8](repeating: 0, count: 64)
        let count = read(3, &bytes, bytes.count)
        if count == 0 { source.cancel(); if endOnEOF { exit(0) }; return }
        guard count > 0, let host = host else { exit(74) }
        rendererRSSInput.append(contentsOf: bytes.prefix(count))
        guard rendererRSSInput.count <= 64 else { exit(65) }
        while let end = rendererRSSInput.firstIndex(of: 10) {
            let line = rendererRSSInput.prefix(upTo: end)
            guard line == Data("snapshot".utf8) else { exit(65) }
            rendererRSSInput.removeSubrange(...end)
            guard let data = try? JSONSerialization.data(withJSONObject: rendererRSSSnapshot(host), options: [.sortedKeys]) else { exit(70) }
            FileHandle(fileDescriptor: 4, closeOnDealloc: false).write(data + Data([10]))
        }
    }
    rendererRSSObserver = source
    source.resume()
}
