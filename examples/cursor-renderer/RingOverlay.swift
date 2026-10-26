// Standalone AppKit renderer for sleight.cursor/1. No sleight or vendor art.
// Build with swiftc RingOverlay.swift -o /tmp/ring-overlay. Running shows windows.
import AppKit
import Darwin

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

final class SocketReader {
    let fd: Int32
    let path: String
    private var identity = stat()
    private var panels: [String: RingPanel] = [:]
    private var warned = false
    private var signals: [DispatchSourceSignal] = []

    init(directory: String, name: String) {
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: directory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        } catch { fail("Cannot create stream directory: \(error)") }
        var info = stat()
        guard lstat(directory, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
            fail("Stream directory must be user-owned, not a symlink, mode 0700")
        }
        path = directory + "/" + name + ".sock"
        var address = sockaddr_un()
        let bytes = Array(path.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
            fail("Socket path too long; use SLEIGHT_CURSOR_STREAM_DIR with a shorter directory")
        }
        guard lstat(path, &info) != 0, errno == ENOENT else {
            fail("Renderer socket already exists; choose another name")
        }
        fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { fail("Cannot create socket") }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            bytes.withUnsafeBytes { source in destination.copyBytes(from: source) }
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else { Darwin.close(fd); fail("Cannot bind socket") }
        guard chmod(path, 0o600) == 0, lstat(path, &identity) == 0,
              Darwin.listen(fd, SOMAXCONN) == 0 else {
            Darwin.close(fd); unlink(path); fail("Cannot secure or listen on socket")
        }
    }

    func start() {
        for number in [SIGINT, SIGTERM] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [self] in stop(); NSApp.terminate(nil) }
            source.resume()
            signals.append(source)
        }
        DispatchQueue.global(qos: .utility).async { [self] in
            while true {
                let client = accept(fd, nil, nil)
                if client < 0 { if errno == EINTR { continue }; return }
                var uid: uid_t = 0, gid: gid_t = 0
                guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else {
                    Darwin.close(client); continue
                }
                DispatchQueue.global(qos: .utility).async { [self] in readLines(client) }
            }
        }
    }

    private func readLines(_ client: Int32) {
        defer { Darwin.close(client) }
        var bytes = [UInt8](repeating: 0, count: 4096)
        var line = Data(), oversized = false
        while true {
            let count = Darwin.read(client, &bytes, bytes.count)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return }
            for byte in bytes.prefix(count) {
                if byte == 10 {
                    if !oversized {
                        let complete = line
                        DispatchQueue.main.async { [self] in receive(complete) }
                    }
                    line.removeAll(keepingCapacity: true)
                    oversized = false
                } else if !oversized {
                    line.append(byte)
                    if line.count > 65536 { line.removeAll(); oversized = true }
                }
            }
        }
    }

    private func receive(_ data: Data) {
        guard let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        guard event["v"] as? String == "sleight.cursor/1" else {
            if !warned {
                warned = true
                FileHandle.standardError.write(Data("Ignoring unsupported cursor stream version\n".utf8))
            }
            return
        }
        guard let session = event["session"] as? String,
              session.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let seq = event["seq"] as? Int, seq > 0,
              let ts = event["ts"] as? Double, ts.isFinite,
              let type = event["type"] as? String else { return }
        if type == "session", event["state"] as? String == "end" {
            panels.removeValue(forKey: session)?.close()
            return
        }
        guard type == "action", let phase = event["phase"] as? String,
              ["aim", "act", "done", "failed", "declined", "skipped"].contains(phase) else { return }
        guard phase != "skipped", phase != "declined", phase != "failed" else {
            panels[session]?.orderOut(nil)
            return
        }
        guard let point = event["point"] as? [Double], point.count == 2,
              point.allSatisfy({ $0.isFinite }),
              let main = NSScreen.screens.first else { return }
        // Global top-left main-display points to AppKit's bottom-left coordinates.
        let location = NSPoint(x: point[0], y: main.frame.maxY - point[1])
        guard NSScreen.screens.contains(where: { $0.frame.contains(location) }) else {
            panels[session]?.orderOut(nil)
            return
        }
        let panel = panels[session] ?? RingPanel()
        panels[session] = panel
        panel.setFrameOrigin(NSPoint(x: location.x - 16, y: location.y - 16))
        panel.orderFrontRegardless() // Never makeKey or activate the application.
    }

    func stop() {
        Darwin.close(fd)
        var current = stat()
        if lstat(path, &current) == 0, current.st_dev == identity.st_dev, current.st_ino == identity.st_ino {
            unlink(path)
        }
        for panel in panels.values { panel.close() }
        panels.removeAll()
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
app.setActivationPolicy(.prohibited)
let reader = SocketReader(directory: directory, name: name)
reader.start()
app.run()
