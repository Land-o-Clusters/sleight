// Output only. No AX calls, provider strings, input values or waits belong here.
import Foundation
import Darwin
import CoreGraphics

final class DriverActionPipe {
    static let shared = DriverActionPipe()
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private let nonce: String
    var enabled: Bool {
        lock.lock(); defer { lock.unlock() }
        return descriptor >= 0
    }
    init(descriptor: Int32? = nil, nonce: String? = nil) {
        let env = ProcessInfo.processInfo.environment
        self.nonce = nonce ?? env["SLEIGHT_DRIVER_NONCE"] ?? ""
        let fd = descriptor ?? (env["SLEIGHT_DRIVER_EVENTS"] == "1" ? 3 : -1)
        if fd >= 0 {
            let flags = fcntl(fd, F_GETFL)
            // A closed reader must never terminate the input helper with SIGPIPE.
            if flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 && fcntl(fd, F_SETNOSIGPIPE, 1) == 0 {
                self.descriptor = fd
            }
        }
    }
    func send(_ record: DriverObject) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard descriptor >= 0 else { return }
        var value = record
        value["protocol"] = "sleight.runtime-action/1"; value["nonce"] = nonce
        guard var data = try? JSONSerialization.data(withJSONObject: value), data.count < 8192 else { return }
        data.append(10)
        let count = data.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!, $0.count) }
        if count != data.count {
            // Drop the channel on a full buffer or partial record. Never await drain.
            Darwin.close(descriptor); descriptor = -1
        }
    }
}

final class DriverActionState {
    let id: Int
    private(set) var kind: String
    private var geometry: DriverObject = [:]
    private let pipe: DriverActionPipe
    private let lock = NSLock()
    private var acted = false, ended = false
    init(id: Int, method: String, args: [Any], pipe: DriverActionPipe = .shared) {
        self.id = id; self.pipe = pipe
        switch method {
        case "click":
            let options = args.count > 1 ? args[1] as? DriverObject : nil
            kind = options?["mouseButton"] as? String == "right" ? "right" : (driverInteger(options?["clickCount"]) ?? 1) > 1 ? "double" : "click"
        case "doubleClick": kind = "double"
        case "rightClick": kind = "right"
        case "drag", "scroll": kind = method
        case "selectText": kind = "select"
        case "performSecondaryAction": kind = "click"
        // Unknown typing focus is conservative, as required by cursor/1.
        default: kind = "key"
        }
    }
    func prepare(window: DriverObject, rect: CGRect? = nil) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard !acted && !ended else { return }
        var projected: DriverObject = [:]
        if let id = UInt32(window["windowId"] as? String ?? ""), id > 0 { projected["id"] = Int(id) }
        if let pid = driverInteger(window["pid"]), pid > 0 { projected["pid"] = pid }
        if let bounds = window["bounds"] as? DriverObject,
           let tuple = Self.tuple([bounds["x"], bounds["y"], bounds["width"], bounds["height"]]) { projected["rect"] = tuple }
        if !projected.isEmpty { geometry["window"] = projected }
        if geometry["rect"] == nil, let rect = rect,
           let tuple = Self.tuple([rect.minX, rect.minY, rect.width, rect.height]) { geometry["rect"] = tuple }
    }
    private static func tuple(_ values: [Any?]) -> [Double]? {
        let numbers = values.compactMap { value -> Double? in
            guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite, abs(n.doubleValue) <= 100000 else { return nil }
            return (n.doubleValue * 100).rounded() / 100
        }
        return numbers.count == values.count ? numbers : nil
    }
    func plan(_ points: [CGPoint]) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard !acted && !ended, let first = points.first,
              let at = Self.tuple([first.x, first.y]) else { return }
        geometry["point"] = at
        if kind == "drag" {
            let thinned = points.count <= 64 ? points : (0..<64).map { points[Int((Double($0) * Double(points.count - 1) / 63).rounded())] }
            let path = thinned.compactMap { Self.tuple([$0.x, $0.y]) }
            if path.count == thinned.count { geometry["path"] = path }
        }
    }
    func admit() {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard !acted && !ended else { return }; acted = true
        var record = geometry; record["id"] = id; record["phase"] = "act"; record["kind"] = kind
        pipe.send(record)
    }
    func waitingForPerson() {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard !acted && !ended else { return }
        pipe.send(["id": id, "phase": "waiting", "kind": kind, "detail": "person"])
    }
    func finish(result: DriverObject?, error: DriverFault?, admitted: Bool) {
        guard lock.try() else { return }; defer { lock.unlock() }
        guard !ended else { return }; ended = true
        let source = error?.disposition ?? result ?? [:]
        let delivery = source["delivery"] as? String ?? (admitted ? "unknown" : "not-sent")
        var receipt: DriverObject = ["delivery": ["not-sent", "unknown", "sent-unverified", "sent-verified"].contains(delivery) ? delivery : "unknown",
            "settled": source["settled"] as? Bool ?? false]
        let basis = source["quietBasis"] as? String ?? "none"
        receipt["basis"] = ["digest", "notification", "notification-none", "captures"].contains(basis) ? basis : "none"
        if error?.code == "USER_STOPPED" { receipt["userStopped"] = true }
        if source["clipboardChanged"] as? Bool == true { receipt["clipboardChanged"] = true }
        var record = geometry; record["id"] = id; record["kind"] = kind
        record["phase"] = error == nil ? "done" : "failed"; record["outcome"] = receipt
        pipe.send(record)
    }
}
