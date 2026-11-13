// Private, collection-only metadata. This code never queries an AX object.
import Foundation
import CoreGraphics
import Darwin

struct DriverGeometryRead {
    let start: Double
    let end: Double
    let before: Int?
    let after: Int?
    let initial: String?
    let rendered: String?
    let final: String?
    let notifications: Bool
    var settled = false
}

// Full inventories have their own descriptor and cap. A short nonblocking write
// drains through one bounded slot; a second inventory closes the channel.
final class DriverGeometryPipe {
    static let shared = DriverGeometryPipe()
    static let limit = 262144
    private var descriptor: Int32 = -1
    private let nonce: String
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "sleight.geometry-output")
    private var pending: Data?
    private var offset = 0
    private var writable: DispatchSourceWrite?
    var enabled: Bool {
        guard lock.try() else { return false }; defer { lock.unlock() }
        return descriptor >= 0
    }
    init(descriptor: Int32? = nil, nonce: String? = nil) {
        let env = ProcessInfo.processInfo.environment
        self.nonce = nonce ?? env["SLEIGHT_DRIVER_NONCE"] ?? ""
        let fd = descriptor ?? (env["SLEIGHT_DRIVER_GEOMETRY"] == "1" ? 4 : -1)
        if fd >= 0 {
            let flags = fcntl(fd, F_GETFL)
            if flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 && fcntl(fd, F_SETNOSIGPIPE, 1) == 0 { self.descriptor = fd }
        }
    }
    func send(_ record: DriverObject) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard descriptor >= 0 else { return }
        // One unfinished inventory owns the entire bounded slot. A later read
        // cannot replace it or be applied as a partial continuation.
        guard pending == nil else { close(); return }
        var record = record
        record["protocol"] = "sleight.glide-geometry/1"; record["nonce"] = nonce
        guard var bytes = try? JSONSerialization.data(withJSONObject: record), bytes.count < Self.limit else {
            close(); return
        }
        bytes.append(10)
        let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!, $0.count) }
        if count == bytes.count { return }
        guard count >= 0 || errno == EAGAIN || errno == EINTR else { close(); return }
        pending = bytes; offset = max(0, count)
        let fd = descriptor, source = DispatchSource.makeWriteSource(fileDescriptor: descriptor, queue: queue)
        writable = source
        source.setEventHandler { [weak self] in self?.flush(fd) }
        source.resume()
    }
    // Called with the short output lock held. No caller waits for pipe drain.
    private func close() {
        writable?.cancel(); writable = nil; pending = nil; offset = 0
        if descriptor >= 0 { Darwin.close(descriptor); descriptor = -1 }
    }
    private func flush(_ fd: Int32) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard descriptor == fd, let bytes = pending else { return }
        let count = bytes.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), $0.count - offset) }
        if count < 0 {
            if errno != EAGAIN && errno != EINTR { close() }
            return
        }
        offset += count
        if offset == bytes.count { pending = nil; offset = 0; writable?.cancel(); writable = nil }
    }
}

final class DriverGeometryBank {
    struct Held {
        let action: Int
        let pid: Int
        let window: String
        let start: String
        let element: DriverElement
    }
    private(set) var held: [Int: Held] = [:]
    private(set) var turn: String?
    private(set) var failed = false
    private var unmappable = false
    private var ended: [String] = []
    private var windows: [String: (Int, String, DriverNode)] = [:]
    let pipe: DriverGeometryPipe
    init(pipe: DriverGeometryPipe = .shared) { self.pipe = pipe }
    func begin(_ token: String) {
        if turn == token { return }
        guard turn == nil, !ended.contains(token) else { failed = true; return }
        turn = token; failed = false
    }
    func end(_ token: String) {
        guard token == turn else { failed = true; return }
        held.removeAll(); windows.removeAll(); unmappable = false; turn = nil; failed = false
        ended.append(token); if ended.count > 512 { ended.removeFirst() }
    }
    func evict(_ window: String) {
        if held.values.contains(where: { $0.window == window }) { failed = true }
    }
    func retain(_ element: DriverElement, window: DriverObject, action: Int, drag: Bool = false) {
        guard turn != nil else { return }
        unmappable = unmappable || drag
        guard !failed, let pid = driverInteger(window["pid"]), let id = window["windowId"] as? String,
              let start = window["processStart"] as? String else { failed = true; return }
        if let old = held[action] {
            // A compound/drag resolving a second object needs a separate envelope.
            if !old.element.node.same(element.node) || !old.element.root.same(element.root) { failed = true }
            return
        }
        guard held.count < 512 else { failed = true; return }
        held[action] = Held(action: action, pid: pid, window: id, start: start, element: element)
    }
    static func box(_ frame: CGRect) -> [Double]? {
        let x = floor(frame.minX), y = floor(frame.minY), r = ceil(frame.maxX), b = ceil(frame.maxY)
        guard [x, y, r, b].allSatisfy({ $0.isFinite && abs($0) <= 100000 }), r > x, b > y else { return nil }
        return [x, y, r - x, b - y]
    }
    func observation(map: DriverReadMap, window: DriverObject, request: Int, reused: Bool) -> DriverObject {
        let evidence = map.geometry
        let pid = driverInteger(window["pid"]) ?? 0, id = window["windowId"] as? String ?? ""
        if let old = windows[id] {
            if old.0 != pid || old.1 != map.processStart || !old.2.same(map.root) { failed = true }
        } else if windows.count < 128 { windows[id] = (pid, map.processStart, map.root) }
        else { failed = true }
        let bounds = driverRect(window["bounds"])
        let root = map.elements.values.first(where: { $0.node.same(map.root) })
        let transform = bounds != nil && root?.frame == bounds && root?.role == "AXWindow" &&
            window["onScreen"] as? Bool == true && window["hidden"] as? Bool == false && window["minimized"] as? Bool == false
        var rows: [DriverObject] = []
        let required = held.values.filter { $0.window == id }.sorted(by: { $0.action < $1.action })
        var index: [DriverSettleNodeKey: [DriverElement]] = [:]
        if !required.isEmpty {
            for element in map.elements.values { index[DriverSettleNodeKey(node: element.node), default: []].append(element) }
        }
        for held in required {
            var row: DriverObject = ["action": held.action, "joined": false, "semantic": false, "clipping": false,
                                     "departed": false, "rects": []]
            let matches = index[DriverSettleNodeKey(node: held.element.node)] ?? []
            if matches.count == 1, let next = matches.first,
               held.pid == pid, held.start == map.processStart,
               held.element.root.same(map.root), next.root.same(map.root) {
                row["joined"] = true
                let semantic = !next.secure && !held.element.secure && next.role == held.element.role &&
                    next.coordinateIdentity == held.element.coordinateIdentity && !next.coordinateIdentity.isEmpty &&
                    !next.coordinateIdentity.values.contains("unsupported")
                row["semantic"] = semantic
                if transform, semantic, let bounds = bounds, let frame = next.frame, Self.box(frame) != nil {
                    let clipped = frame.intersection(bounds)
                    row["clipping"] = true
                    if clipped.isNull || clipped.isEmpty { row["departed"] = true }
                    else if let rect = Self.box(clipped) { row["rects"] = [rect] }
                    else { row["clipping"] = false }
                }
            }
            rows.append(row)
        }
        return ["type": "observation", "turn": turn ?? "", "request": request, "read": map.id,
            "pid": pid, "window": id, "processStart": map.processStart,
            "bounds": bounds.flatMap(Self.box) as Any? ?? NSNull(), "reused": reused,
            "acquired": evidence.map { [$0.start, $0.end] } as Any? ?? NSNull(),
            "before": evidence?.before as Any? ?? NSNull(), "after": evidence?.after as Any? ?? NSNull(),
            "initial": evidence?.initial as Any? ?? NSNull(), "rendered": evidence?.rendered as Any? ?? NSNull(),
            "final": evidence?.final as Any? ?? NSNull(), "notifications": evidence?.notifications ?? false,
            "drag": unmappable, "settled": evidence?.settled ?? false, "complete": !map.truncated, "continuous": !failed, "transform": transform,
            "references": rows]
    }
    func publish(map: DriverReadMap, window: DriverObject, request: Int, reused: Bool) {
        guard turn != nil, pipe.enabled else { return }
        pipe.send(observation(map: map, window: window, request: request, reused: reused))
    }
}
