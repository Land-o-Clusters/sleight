// Standalone AppKit renderer for sleight.cursor/1. No sleight or vendor art.
// Build with swiftc RingOverlay.swift -o /tmp/ring-overlay. Running shows windows.
import AppKit
import Darwin
import CoreFoundation

final class RingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 32, height: 32),
                   styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        ignoresMouseEvents = true
        sharingType = .none
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        contentView = CircleView(frame: NSRect(x: 0, y: 0, width: 32, height: 32))
        setAccessibilityElement(false)
    }
}

final class CircleView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.setStroke()
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 4, dy: 4))
        circle.lineWidth = 2
        circle.stroke()
    }
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

// Match listen.mjs: JSON booleans are NSNumber too, so reject them explicitly.
func finiteNumber(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite else { return nil }
    return number.doubleValue
}
func safeInteger(_ value: Any?) -> Bool {
    guard let number = finiteNumber(value) else { return false }
    return number >= 0 && number <= 9007199254740991 && number.rounded() == number
}
func coordinates(_ value: Any?, count: Int) -> Bool {
    guard let array = value as? [Any], array.count == count,
          array.allSatisfy({ finiteNumber($0) != nil }) else { return false }
    return count != 4 || (finiteNumber(array[2])! >= 0 && finiteNumber(array[3])! >= 0)
}
func parseEvent(_ data: Data, warn: () -> Void) -> [String: Any]? {
    guard var e = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
    guard e["v"] as? String == "sleight.cursor/1" else { warn(); return nil }
    guard let session = e["session"] as? String,
          session.utf8.count == 32,
          session.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
          safeInteger(e["seq"]), finiteNumber(e["seq"])! >= 1, finiteNumber(e["ts"]) != nil,
          let type = e["type"] as? String else { return nil }
    switch type {
    case "session": guard ["start", "end"].contains(e["state"] as? String ?? "") else { return nil }
    case "status": guard ["thinking", "waiting", "error", "done", "handback", "idle"].contains(e["state"] as? String ?? "") else { return nil }
    case "action":
        guard ["aim", "act", "done", "failed", "declined", "skipped"].contains(e["phase"] as? String ?? ""),
              ["click", "double", "right", "key", "type", "drag", "scroll", "select", "navigate", "move"].contains(e["kind"] as? String ?? "") else { return nil }
    default: return nil
    }
    if type == "action" { e.removeValue(forKey: "state") }
    else { e.removeValue(forKey: "phase"); e.removeValue(forKey: "kind") }
    if let p = e["point"], !coordinates(p, count: 2) { return nil }
    if let p = e["path"] {
        guard let array = p as? [Any], array.count <= 64,
              array.allSatisfy({ coordinates($0, count: 2) }) else { return nil }
    }
    if let r = e["rect"], !coordinates(r, count: 4) { return nil }
    for key in ["call", "host", "version", "source", "timing", "role", "reason", "label", "app"] {
        if let value = e[key], !(value is String) { return nil }
    }
    for key in ["index", "count"] { if let value = e[key], !safeInteger(value) { return nil } }
    if let value = e["window"] {
        guard let window = value as? [String: Any] else { return nil }
        for key in ["id", "pid"] { if let v = window[key], !safeInteger(v) { return nil } }
        for key in ["app", "bundle"] { if let v = window[key], !(v is String) { return nil } }
        if let r = window["rect"], !coordinates(r, count: 4) { return nil }
        if let exposure = window["exposure"] {
            guard let s = exposure as? String,
                  ["exposed", "covered", "offscreen", "other-space", "minimized"].contains(s) else { return nil }
        }
    }
    if let value = e["display"] {
        guard let display = value as? [String: Any] else { return nil }
        if let v = display["id"], !safeInteger(v) { return nil }
        if let v = display["scale"] { guard let n = finiteNumber(v), n > 0 else { return nil } }
    }
    return e // Drawing reads only the known fields above; extensions are ignored.
}

final class SessionView {
    var panel: RingPanel?
    var owners = Set<Int>()
    var drags = Set<String>()
    var overflow = false
    var expiry: DispatchSourceTimer?
}
final class Connection {
    let id: Int
    let source: DispatchSourceRead
    var line = Data()
    var oversized = false
    init(id: Int, source: DispatchSourceRead) { self.id = id; self.source = source }
}

final class SocketReader {
    let fd: Int32
    let path: String
    private var identity = stat()
    // All session, panel and TTL operations run on main, never on the reader queue.
    private var sessions: [String: SessionView] = [:]
    private var order: [String] = []
    private var connected = Set<Int>()
    private var warned = false
    private var signals: [DispatchSourceSignal] = []
    private let readerQueue = DispatchQueue(label: "cursor.serial-reader", qos: .utility)
    private var acceptSource: DispatchSourceRead?
    private var clients: [Int32: Connection] = [:] // readerQueue only, at most 16.
    private var connectionCount = 0 // Includes disconnects waiting for main.
    private var nextID = 0
    private let lineLock = NSLock()
    private var lines: [(Data, Int)] = [] // At most 128 lines, dropping the oldest.
    private var drainScheduled = false

    init(directory: String, name: String) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: directory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        } catch { fail("Cannot create stream directory: \(error)") }
        var info = stat()
        guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o7777 == 0o700 else {
            fail("Stream directory must be user-owned, not a symlink, mode 0700")
        }
        path = directory + "/" + name + ".sock"
        var address = sockaddr_un()
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            fail("Socket path too long; use SLEIGHT_CURSOR_STREAM_DIR with a shorter directory")
        }
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { fail("Cannot create socket") }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            bytes.withUnsafeBytes { source in destination.copyBytes(from: source) }
        }
        func bindSocket() -> Int32 {
            withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
        }
        var bound = bindSocket()
        if bound != 0 && errno == EADDRINUSE {
            guard lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFSOCK,
                  info.st_uid == getuid(), info.st_mode & 0o7777 == 0o600 else {
                fail("Existing renderer socket must be user-owned, not a symlink, mode 0600 exactly")
            }
            let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard probe >= 0 else { fail("Cannot create socket probe") }
            guard fcntl(probe, F_SETFL, O_NONBLOCK) == 0 else { fail("Cannot make probe nonblocking") }
            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            let refused = result != 0 && errno == ECONNREFUSED
            Darwin.close(probe)
            var current = stat()
            guard refused else { fail("Renderer socket already in use or probe inconclusive") }
            guard lstat(path, &current) == 0, current.st_dev == info.st_dev,
                  current.st_ino == info.st_ino, current.st_mode == info.st_mode,
                  current.st_uid == info.st_uid, unlink(path) == 0 else { fail("Renderer socket changed during probe") }
            bound = bindSocket() // Exactly one retry after ECONNREFUSED.
        }
        guard bound == 0 else { Darwin.close(fd); fail("Cannot bind socket") }
        guard chmod(path, 0o600) == 0, lstat(path, &identity) == 0,
              Darwin.listen(fd, SOMAXCONN) == 0 else {
            Darwin.close(fd); unlink(path); fail("Cannot secure or listen on socket")
        }
        guard fcntl(fd, F_SETFL, O_NONBLOCK) == 0 else {
            Darwin.close(fd); unlink(path); fail("Cannot make listener nonblocking")
        }
    }

    func start() {
        for number in [SIGINT, SIGTERM, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [self] in stop(); NSApp.terminate(nil) }
            source.resume()
            signals.append(source)
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: readerQueue)
        source.setEventHandler { [self] in
            // Bound each readiness turn as well as the total live connections.
            for _ in 0..<16 {
                let client = accept(fd, nil, nil)
                if client < 0 { if errno == EINTR { continue }; return }
                var uid: uid_t = 0, gid: gid_t = 0
                guard connectionCount < 16, getpeereid(client, &uid, &gid) == 0, uid == getuid(),
                      fcntl(client, F_SETFL, O_NONBLOCK) == 0 else {
                    Darwin.close(client); continue
                }
                connectionCount += 1
                nextID += 1
                let id = nextID
                let reader = DispatchSource.makeReadSource(fileDescriptor: client, queue: readerQueue)
                let connection = Connection(id: id, source: reader)
                clients[client] = connection
                DispatchQueue.main.async { [self] in connected.insert(id) }
                reader.setEventHandler { [self, connection] in readLines(client, connection) }
                reader.setCancelHandler { Darwin.close(client) }
                reader.resume()
            }
        }
        source.setCancelHandler { [fd] in Darwin.close(fd) }
        acceptSource = source
        source.resume()
    }

    private func readLines(_ client: Int32, _ connection: Connection) {
        var bytes = [UInt8](repeating: 0, count: 4096)
        let count = Darwin.read(client, &bytes, bytes.count)
        if count < 0 && [EINTR, EAGAIN].contains(errno) { return }
        if count <= 0 {
            clients.removeValue(forKey: client)
            connection.source.setEventHandler(handler: nil)
            connection.source.cancel()
            DispatchQueue.main.async { [self] in
                // Flush this connection's bounded backlog before removing its views.
                lineLock.lock()
                let remaining = lines.filter { $0.1 == connection.id }
                lines.removeAll { $0.1 == connection.id }
                lineLock.unlock()
                for (data, id) in remaining { receive(data, id) }
                connected.remove(connection.id)
                for (session, view) in Array(sessions) {
                    view.owners.remove(connection.id)
                    if view.owners.isEmpty { remove(session) }
                }
                readerQueue.async { [self] in connectionCount -= 1 }
            }
            return
        }
        for byte in bytes.prefix(count) {
            if byte == 10 {
                if !connection.oversized { enqueue(connection.line, connection.id) }
                connection.line.removeAll(keepingCapacity: true)
                connection.oversized = false
            } else if !connection.oversized {
                connection.line.append(byte)
                if connection.line.count > 65536 { connection.line.removeAll(); connection.oversized = true }
            }
        }
    }

    private func enqueue(_ data: Data, _ connection: Int) {
        lineLock.lock()
        if lines.count == 128 { lines.removeFirst() }
        lines.append((data, connection))
        let schedule = !drainScheduled
        drainScheduled = true
        lineLock.unlock()
        if schedule { DispatchQueue.main.async { [self] in drain() } }
    }

    private func drain() {
        lineLock.lock()
        let batch = Array(lines.prefix(32))
        lines.removeFirst(batch.count)
        lineLock.unlock()
        for (data, connection) in batch where connected.contains(connection) { receive(data, connection) }
        lineLock.lock()
        let more = !lines.isEmpty
        drainScheduled = more
        lineLock.unlock()
        if more { DispatchQueue.main.async { [self] in drain() } }
    }

    private func remove(_ session: String) {
        guard let view = sessions.removeValue(forKey: session) else { return }
        view.expiry?.cancel()
        view.panel?.close()
        order.removeAll { $0 == session }
    }

    private func receive(_ data: Data, _ connection: Int) {
        guard let event = parseEvent(data, warn: { [self] in
            if !warned {
                warned = true
                FileHandle.standardError.write(Data("Ignoring unsupported cursor stream version\n".utf8))
            }
        }) else { return }
        let session = event["session"] as! String, type = event["type"] as! String
        let state = event["state"] as? String ?? ""
        if (type == "session" && state == "end") ||
            (type == "status" && ["done", "handback", "idle", "error"].contains(state)) {
            remove(session)
            return
        }
        if sessions[session] == nil {
            if sessions.count == 4 { remove(order[0]) }
            sessions[session] = SessionView()
            order.append(session)
        }
        let view = sessions[session]!
        view.owners.insert(connection)
        if view.expiry == nil {
            let expiry = DispatchSource.makeTimerSource(queue: .main)
            expiry.setEventHandler { [weak self] in self?.remove(session) }
            view.expiry = expiry
            expiry.schedule(deadline: .now() + 3)
            expiry.resume()
        } else { view.expiry?.schedule(deadline: .now() + 3) }
        guard type == "action" else { return }
        let phase = event["phase"] as! String
        let call = "\(event["call"] as? String ?? ""):\(event["index"] as? Int ?? 0)"
        if event["kind"] as? String == "drag" && ["aim", "act"].contains(phase) {
            if view.drags.contains(call) || view.drags.count < 64 { view.drags.insert(call) } else { view.overflow = true }
        }
        let dragging = !view.drags.isEmpty || view.overflow
        if event["kind"] as? String == "drag" && ["done", "failed", "declined", "skipped"].contains(phase) { view.drags.remove(call) }
        guard !dragging, !["skipped", "declined", "failed"].contains(phase) else {
            view.panel?.orderOut(nil); return
        }
        guard let point = event["point"] as? [Double], point.count == 2,
              point.allSatisfy({ $0.isFinite }),
              let main = NSScreen.screens.first else { return }
        // Global top-left main-display points to AppKit's bottom-left coordinates.
        let location = NSPoint(x: main.frame.minX + point[0], y: main.frame.maxY - point[1])
        // Inclusive edges accept y = 0, which maps to the main display's maxY.
        guard NSScreen.screens.contains(where: {
            location.x >= $0.frame.minX && location.x <= $0.frame.maxX &&
            location.y >= $0.frame.minY && location.y <= $0.frame.maxY
        }) else {
            view.panel?.orderOut(nil)
            return
        }
        let panel = view.panel ?? RingPanel()
        view.panel = panel
        panel.setFrameOrigin(NSPoint(x: location.x - 16, y: location.y - 16))
        panel.orderFrontRegardless()
    }

    func stop() {
        readerQueue.sync {
            acceptSource?.setEventHandler(handler: nil)
            acceptSource?.cancel()
            for client in clients.values {
                client.source.setEventHandler(handler: nil)
                client.source.cancel()
            }
            clients.removeAll()
        }
        var current = stat()
        if lstat(path, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino {
            unlink(path)
        }
        for session in Array(sessions.keys) { remove(session) }
        connected.removeAll()
    }
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.isEmpty || (args.count == 2 && args[0] == "--name") else {
    fail("Usage: ring-overlay [--name ring]")
}
let name = args.isEmpty ? "ring" : args[1]
guard name.range(of: "^[A-Za-z0-9_-]{1,32}$", options: .regularExpression) != nil else {
    fail("Invalid renderer name")
}
let directory = ProcessInfo.processInfo.environment["SLEIGHT_CURSOR_STREAM_DIR"] ??
    FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/sleight/cursor/renderers"
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let reader = SocketReader(directory: directory, name: name)
reader.start()
app.run()
