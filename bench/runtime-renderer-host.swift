// UC2C live witness. Validation and selftest exit before NSApplication exists.
import AppKit
import ApplicationServices
import CoreGraphics
import Darwin

let rendererApps = ["vscode": ("com.microsoft.VSCode", "/Applications/Visual Studio Code.app"),
                    "discord": ("com.hnc.Discord", "/Applications/Discord.app")]
func rendererPID(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
          number.doubleValue > 0, number.doubleValue <= Double(Int32.max) else { return nil }
    return number.intValue
}
func rendererRequestValid(_ row: [String: Any]) -> Bool {
    guard let op = row["op"] as? String else { return false }
    switch op {
    case "renderer-watch-begin", "renderer-watch-end", "renderer-close": return Set(row.keys) == ["op"]
    case "renderer-launch":
        guard Set(row.keys) == ["op", "app", "root"], rendererApps[row["app"] as? String ?? ""] != nil,
              let path = row["root"] as? String,
              path.range(of: #"^/private/tmp/sleight-uc2c-[A-Za-z0-9]+$"#, options: .regularExpression) != nil else { return false }
        return true
    case "renderer-cover":
        guard Set(row.keys) == ["op", "window"], let window = row["window"] as? [String: Any],
              rendererPID(window["pid"]) != nil,
              let id = window["windowId"] as? String, let number = UInt32(id), number > 0, String(number) == id,
              let bundle = window["bundleId"] as? String, rendererApps.values.contains(where: { $0.0 == bundle }) else { return false }
        return true
    default: return false
    }
}
func rendererEmit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    print(String(decoding: data, as: UTF8.self)); fflush(stdout)
}
if CommandLine.arguments.dropFirst() == ["--validate"] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    let row = data.count <= 65536 ? (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) : nil
    let valid = row.map(rendererRequestValid) ?? false
    rendererEmit(["valid": valid, "windowsCreated": 0, "inputGenerated": false]); exit(valid ? 0 : 65)
}
if CommandLine.arguments.dropFirst() == ["--selftest"] {
    guard rendererRequestValid(["op": "renderer-watch-begin"]),
          !rendererRequestValid(["op": "renderer-launch", "app": "Terminal", "root": "/private/tmp/sleight-uc2c-abc"]),
          !rendererRequestValid(["op": "renderer-launch", "app": "vscode", "root": "/private/tmp/sleight-uc2c-abc/../x"]) else { exit(70) }
    rendererEmit(["cases": 3, "windowsCreated": 0, "inputGenerated": false]); exit(0)
}
guard CommandLine.arguments.dropFirst() == ["--serve"] else { exit(64) }

@MainActor final class RendererWitness {
    var owned: NSRunningApplication?, birth: Date?, bundle: String?, windowID: UInt32?
    var cover: NSPanel?, tap: CFMachPort?, tapSource: CFRunLoopSource?, timer: Timer?
    var events = [[String: Any]](), samples = [[String: Any]](), started = 0.0
    var overflow = false, tapFailed = false
    var launchPending = false, stopping = false, closing = false
    var exitStatus: Int32 = 0
    func covered() -> Bool {
        guard live(), let app = owned, let id = windowID, let panel = cover, panel.isVisible,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
              let coverIndex = windows.firstIndex(where: { $0[kCGWindowNumber as String] as? Int == panel.windowNumber }),
              let targetIndex = windows.firstIndex(where: { $0[kCGWindowNumber as String] as? UInt32 == id &&
                  $0[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier }), coverIndex < targetIndex,
              let coverRaw = windows[coverIndex][kCGWindowBounds as String] as? [String: Any],
              let targetRaw = windows[targetIndex][kCGWindowBounds as String] as? [String: Any],
              let coverFrame = CGRect(dictionaryRepresentation: coverRaw as CFDictionary),
              let targetFrame = CGRect(dictionaryRepresentation: targetRaw as CFDictionary) else { return false }
        return coverFrame.contains(targetFrame)
    }
    func bundleProcesses(_ path: String) -> [pid_t]? {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return nil }
        var pids = [pid_t](repeating: 0, count: Int(count) + 256)
        let bytes = Int32(pids.count * MemoryLayout<pid_t>.stride)
        let used = proc_listallpids(&pids, bytes)
        guard used > 0, used < pids.count else { return nil }
        return pids.prefix(Int(used)).filter { pid in
            // proc_info.h defines the unavailable compound macro as 4 * MAXPATHLEN.
            var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
            guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return false }
            return String(cString: buffer).hasPrefix(path + "/")
        }
    }
    func live() -> Bool {
        guard let app = owned else { return false }
        return !app.isTerminated && app.launchDate == birth && app.bundleIdentifier == bundle
    }
    func pump(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
    func sample() {
        guard samples.count < 4096 else { overflow = true; return }
        guard let point = CGEvent(source: nil)?.location else { tapFailed = true; return }
        samples.append(["ms": (ProcessInfo.processInfo.systemUptime - started) * 1000,
            "frontmostPID": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
            "pointer": [point.x, point.y], "covered": covered()])
    }
    func stopWatching() {
        timer?.invalidate(); timer = nil
        if let source = tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap = tap { CFMachPortInvalidate(tap) }
        tap = nil; tapSource = nil
    }
    func close() -> Bool {
        guard !closing else { return false }
        closing = true; defer { closing = false }
        stopWatching(); cover?.close(); cover = nil; windowID = nil
        guard !launchPending else { return false }
        guard let app = owned else { return true }
        if !app.isTerminated {
            guard live(), app.terminate() else { return false }
        }
        let end = ProcessInfo.processInfo.systemUptime + 10
        guard let path = app.bundleURL?.path else { return false }
        while ProcessInfo.processInfo.systemUptime < end {
            if app.isTerminated, let left = bundleProcesses(path), left.isEmpty { break }
            pump(0.1)
        }
        guard app.isTerminated, let left = bundleProcesses(path), left.isEmpty else { return false }
        owned = nil; birth = nil; bundle = nil
        return true
    }
    func launch(_ row: [String: Any]) -> [String: Any] {
        guard owned == nil, !launchPending, !stopping, let key = row["app"] as? String, let spec = rendererApps[key],
              let root = row["root"] as? String,
              URL(fileURLWithPath: root).resolvingSymlinksInPath().path == root,
              let attrs = try? FileManager.default.attributesOfItem(atPath: root),
              attrs[.ownerAccountID] as? UInt32 == getuid(), attrs[.posixPermissions] as? Int == 0o700,
              NSRunningApplication.runningApplications(withBundleIdentifier: spec.0).isEmpty,
              Bundle(path: spec.1)?.bundleIdentifier == spec.0 else { return ["error": "RENDERER_FIXTURE_UNSAFE"] }
        let files = FileManager.default
        do {
            for path in ["profile", "extensions", "home", "home/Library/Application Support", "config"] {
                try files.createDirectory(atPath: root + "/" + path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            }
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false; config.addsToRecentItems = false; config.createsNewApplicationInstance = true
            config.arguments = ["--user-data-dir=" + root + "/profile"]
            config.environment = ["HOME": root + "/home", "CFFIXED_USER_HOME": root + "/home", "XDG_CONFIG_HOME": root + "/config"]
            if key == "vscode" {
                try files.createDirectory(atPath: root + "/profile/User", withIntermediateDirectories: true)
                let settings: [String: Any] = ["editor.accessibilitySupport": "on", "workbench.startupEditor": "none",
                    "workbench.editor.enablePreview": false, "update.mode": "none", "telemetry.telemetryLevel": "off",
                    "security.workspace.trust.enabled": false, "window.restoreWindows": "none", "extensions.autoUpdate": false]
                try JSONSerialization.data(withJSONObject: settings).write(to: URL(fileURLWithPath: root + "/profile/User/settings.json"))
                for name in ["UC2C-a.txt", "UC2C-b.txt"] { try Data(name.utf8).write(to: URL(fileURLWithPath: root + "/" + name)) }
                config.arguments += ["--extensions-dir=" + root + "/extensions", "--disable-extensions", "--skip-welcome",
                    "--skip-release-notes", "--disable-workspace-trust", "--disable-telemetry", "--disable-updates",
                    "--skip-add-to-recently-opened", "--new-window", root + "/UC2C-a.txt", root + "/UC2C-b.txt"]
            }
            var finished = false, launchError = false
            launchPending = true
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: spec.1), configuration: config) { app, error in
                DispatchQueue.main.async {
                    self.owned = app; self.birth = app?.launchDate; self.bundle = spec.0
                    self.launchPending = false
                    launchError = error != nil; finished = true
                }
            }
            let end = ProcessInfo.processInfo.systemUptime + 30
            while !finished && ProcessInfo.processInfo.systemUptime < end { pump(0.02) }
            guard finished, !launchError, live(), birth != nil, let app = owned else { return ["error": "RENDERER_LAUNCH_UNCONFIRMED"] }
            while ProcessInfo.processInfo.systemUptime < end {
                let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
                let candidates = windows.filter { $0[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier && $0[kCGWindowLayer as String] as? Int == 0 }
                if candidates.count == 1, let id = candidates[0][kCGWindowNumber as String] as? UInt32 {
                    windowID = id
                    return ["pid": app.processIdentifier, "bundle": spec.0, "windowId": String(id), "temporaryProfile": true]
                }
                pump(0.05)
            }
        } catch { return ["error": "RENDERER_FIXTURE_SETUP_FAILED"] }
        return ["error": "RENDERER_WINDOW_UNCONFIRMED"]
    }
    func receive(_ row: [String: Any]) -> [String: Any] {
        guard rendererRequestValid(row), let op = row["op"] as? String else { return ["error": "INVALID_REQUEST"] }
        if op == "renderer-launch" { return launch(row) }
        if op == "renderer-close" { return ["confirmed": close()] }
        guard live(), let app = owned, let id = windowID else { return ["error": "IDENTITY_CHANGED"] }
        if op == "renderer-cover" {
            guard let window = row["window"] as? [String: Any], window["pid"] as? Int32 == app.processIdentifier,
                  window["bundleId"] as? String == bundle, window["windowId"] as? String == String(id),
                  let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
                  let info = rows.first(where: { $0[kCGWindowNumber as String] as? UInt32 == id && $0[kCGWindowOwnerPID as String] as? Int32 == app.processIdentifier }),
                  let raw = info[kCGWindowBounds as String] as? [String: Any], let frame = CGRect(dictionaryRepresentation: raw as CFDictionary),
                  frame.width > 0, frame.height > 0, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier else {
                return ["error": "RENDERER_COVER_UNCONFIRMED"]
            }
            if cover == nil {
                cover = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                cover!.level = .floating; cover!.ignoresMouseEvents = true; cover!.backgroundColor = .systemGray
                cover!.collectionBehavior = [.transient, .ignoresCycle, .stationary]
            }
            let top = CGDisplayBounds(CGMainDisplayID()).height
            cover!.setFrame(CGRect(x: frame.minX, y: top - frame.maxY, width: frame.width, height: frame.height), display: true)
            cover!.orderFrontRegardless()
            return ["covered": covered()]
        }
        if op == "renderer-watch-begin" {
            guard tap == nil, covered(), CGPreflightListenEventAccess() else { return ["error": "WITNESS_EVENT_PERMISSION_REQUIRED"] }
            events = []; samples = []; overflow = false; tapFailed = false; started = ProcessInfo.processInfo.systemUptime
            let mask = [CGEventType.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .scrollWheel, .otherMouseDown, .otherMouseUp, .otherMouseDragged]
                .reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
            tap = CGEvent.tapCreateForPid(pid: app.processIdentifier, place: .tailAppendEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: { _, type, event, context in
                    MainActor.assumeIsolated {
                        let witness = Unmanaged<RendererWitness>.fromOpaque(context!).takeUnretainedValue()
                        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { witness.tapFailed = true }
                        else if witness.events.count >= 4096 { witness.overflow = true }
                        else { witness.events.append(["type": type.rawValue, "flags": event.flags.rawValue,
                            "pid": event.getIntegerValueField(.eventTargetUnixProcessID),
                            "source": event.getIntegerValueField(.eventSourceStateID),
                            "windowId": event.getIntegerValueField(CGEventField(rawValue: 91)!)]) }
                    }
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque())
            guard let tap = tap, let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
                stopWatching(); return ["error": "WITNESS_EVENT_TAP_UNAVAILABLE"]
            }
            tapSource = source; CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            sample()
            timer = Timer(timeInterval: 0.02, repeats: true) { [weak self] _ in MainActor.assumeIsolated { self?.sample() } }
            RunLoop.main.add(timer!, forMode: .common)
            return ["watching": true]
        }
        if op == "renderer-watch-end" {
            guard tap != nil else { return ["error": "WITNESS_NOT_WATCHING"] }
            // Give queued input its last run-loop slice before reading the log.
            pump(0.02); sample(); stopWatching()
            return ["covered": covered(), "sampleIntervalMs": 20, "samples": samples, "events": events,
                "overflow": overflow, "tapFailed": tapFailed]
        }
        return ["error": "INVALID_REQUEST"]
    }
}
let parent = getppid()
let host = MainActor.assumeIsolated { RendererWitness() }
let application = NSApplication.shared; application.setActivationPolicy(.accessory)
func stopRendererHost(_ status: Int32) {
    DispatchQueue.main.async {
        host.stopping = true; host.exitStatus = status
        if !host.launchPending && !host.closing { exit(host.close() ? status : 74) }
    }
}
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count <= 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { stopRendererHost(65); return }
        DispatchQueue.main.async { rendererEmit(host.receive(row)) }
    }
    stopRendererHost(0)
}
let parentTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    DispatchQueue.main.async {
        if getppid() != parent || host.stopping {
            host.stopping = true
            if !host.launchPending && !host.closing { exit(host.close() ? host.exitStatus : 74) }
        }
    }
}
application.run()
