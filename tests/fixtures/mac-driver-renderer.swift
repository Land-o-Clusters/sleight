
// Only fake trees, fake AX storage and a fake clock run in this executable.
// DriverMain runs only with its explicit fake-inventory argument.
// The explicit fixture mode also exercises the production stdio registrar.
if CommandLine.arguments.dropFirst().first == "--fixture" { driverMain() }

final class RendererFixtureCapture: DriverCaptureBackend {
    func preflight() -> Bool { true }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        let context = CGContext(data: nil, width: 100, height: 100, bitsPerComponent: 8, bytesPerRow: 400,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return DriverCapturedImage(image: context.makeImage()!, target: target)
    }
}

enum RendererFixtureIO {
    static var rawAXWrites = 0
    static var openError: Int32 = ProcessInfo.processInfo.environment["SLEIGHT_RENDERER_FIXTURE_OPEN_ERROR"] == "EMFILE" ? EMFILE : 0
    static var statError: Int32 = 0, readError: Int32 = 0
    static var foreignOwner = false
    static var saveError: Int32 = 0
    static var processError: Int32 = 0, processPartial = false
    static var liveStart = "1.2", staleStart: String?, exited = false, allRecordedLive = false
    static var processCalls = 0, recordOpens = 0, directorySyncs = 0
    static var syncError: Int32 = 0
    static let errors: [String: Int32] = ["EMFILE": EMFILE, "ENFILE": ENFILE, "EINTR": EINTR, "EAGAIN": EAGAIN,
        "EACCES": EACCES, "EPERM": EPERM, "ENOMEM": ENOMEM, "EIO": EIO, "EISDIR": EISDIR,
        "ENXIO": ENXIO, "EOPNOTSUPP": EOPNOTSUPP, "ESRCH": ESRCH]
}
// Intercept every production AX mutation, including a future recovery regression.
// Never forward it to macOS. The canary proves this counter can detect a write.
func rendererFixtureAXWrite(_ element: AXUIElement?, _ attribute: CFString, _ value: CFTypeRef) -> AXError {
    RendererFixtureIO.rawAXWrites += 1
    fputs("renderer-fixture-AX-write\n", stderr)
    return .failure
}
func rendererFixtureOpenat(_ directory: Int32, _ name: String, _ flags: Int32) -> Int32 {
    RendererFixtureIO.recordOpens += 1
    if RendererFixtureIO.openError != 0 { errno = RendererFixtureIO.openError; return -1 }
    return openat(directory, name, flags)
}
func rendererFixtureDirectorySync(_ fd: Int32) -> Int32 {
    RendererFixtureIO.directorySyncs += 1
    if RendererFixtureIO.syncError != 0 { errno = RendererFixtureIO.syncError; return -1 }
    return fsync(fd)
}
func rendererFixtureSaveOpenat(_ directory: Int32, _ name: String, _ flags: Int32, _ mode: mode_t) -> Int32 {
    if RendererFixtureIO.saveError != 0 { errno = RendererFixtureIO.saveError; return -1 }
    return openat(directory, name, flags, mode)
}
func rendererFixtureFstat(_ fd: Int32, _ info: UnsafeMutablePointer<stat>) -> Int32 {
    if RendererFixtureIO.statError != 0 { errno = RendererFixtureIO.statError; return -1 }
    return fstat(fd, info)
}
func rendererFixtureDirectoryFstat(_ fd: Int32, _ info: UnsafeMutablePointer<stat>) -> Int32 {
    let result = fstat(fd, info)
    if result == 0 && RendererFixtureIO.foreignOwner { info.pointee.st_uid = getuid() &+ 1 }
    return result
}
func rendererFixtureRead(_ fd: Int32, _ bytes: UnsafeMutableRawPointer, _ count: Int) -> Int {
    if RendererFixtureIO.readError != 0 { errno = RendererFixtureIO.readError; return -1 }
    return Darwin.read(fd, bytes, count)
}
func rendererFixturePIDInfo(_ pid: pid_t, _ flavor: Int32, _ arg: UInt64,
                            _ buffer: UnsafeMutableRawPointer, _ size: Int32) -> Int32 {
    RendererFixtureIO.processCalls += 1
    if RendererFixtureIO.processPartial { errno = ESRCH; return size - 1 }
    if RendererFixtureIO.processError != 0 { errno = RendererFixtureIO.processError; return 0 }
    let start: String?
    if pid == 42 || RendererFixtureIO.allRecordedLive {
        start = RendererFixtureIO.exited ? nil : RendererFixtureIO.liveStart
    } else { start = RendererFixtureIO.staleStart }
    guard let start = start else { errno = ESRCH; return 0 }
    let parts = start.split(separator: ".").map { UInt64($0)! }
    let info = buffer.assumingMemoryBound(to: proc_bsdinfo.self)
    info.pointee.pbi_start_tvsec = parts[0]; info.pointee.pbi_start_tvusec = parts[1]
    return size
}
// The production stdio loop retains this store for the client's whole session.
func rendererFixtureStartup() -> (() throws -> DriverRendererRestoreStore)? {
    guard ProcessInfo.processInfo.environment["SLEIGHT_RENDERER_FIXTURE_RUNTIME"] != nil else { return nil }
    return { try DriverRendererRestoreStore.startup() }
}
while let line = readLine() {
    let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! DriverObject
    RendererFixtureIO.rawAXWrites = 0
    if input["axWriteCanary"] as? Bool == true {
        _ = rendererFixtureAXWrite(nil, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        print("{\"rawAXWrites\":\(RendererFixtureIO.rawAXWrites)}")
        continue
    }
    if input["liveAssistiveStates"] as? Bool == true {
        // These three branches are pure unknown values, with no settings or
        // NSWorkspace access. Keep the production provider in this test.
        var states: DriverObject = [:]
        for source in ["voiceControl", "fullKeyboardAccess", "unknown-fixture-source"] {
            states[source] = try DriverRendererAssistiveProviders.live.state(source).map { $0 as Any } ?? NSNull()
        }
        print(String(data: try JSONSerialization.data(withJSONObject: states), encoding: .utf8)!)
        continue
    }
    let stateDirectory = input["stateDirectory"] as! String
    let fixtureParent = getppid()
    let appFile = stateDirectory + "/fake-attributes.json"
    var attributes = input["attributes"] as? DriverObject ?? [:]
    if input["persistentApp"] as? Bool == true, let data = FileManager.default.contents(atPath: appFile) {
        attributes = try JSONSerialization.jsonObject(with: data) as! DriverObject
    }
    var events = [String](), writes = [[Any]](), waits = [Double](), walks = 0, clock = 0.0
    let fail = input["fail"] as? String ?? ""
    var failedReadback = false
    var output: DriverObject = [:]
    var rendererChildren: NSMutableArray?
    var pendingRestore = Set<String>()
    var cancelled = input["cancelBeforeRecovery"] as? Bool == true, recoveryChecks = 0
    let bundleID = input["bundleID"] as? String ?? "test.fixture"
    RendererFixtureIO.openError = RendererFixtureIO.errors[input["openError"] as? String ?? ""] ?? 0
    RendererFixtureIO.statError = RendererFixtureIO.errors[input["statError"] as? String ?? ""] ?? 0
    RendererFixtureIO.foreignOwner = input["foreignOwner"] as? Bool == true
    RendererFixtureIO.readError = RendererFixtureIO.errors[input["readError"] as? String ?? ""] ?? 0
    RendererFixtureIO.saveError = RendererFixtureIO.errors[input["saveError"] as? String ?? ""] ?? 0
    RendererFixtureIO.processError = RendererFixtureIO.errors[input["processError"] as? String ?? ""] ?? 0
    RendererFixtureIO.processPartial = input["processPartial"] as? Bool == true
    RendererFixtureIO.liveStart = input["liveStart"] as? String ?? "1.2"
    RendererFixtureIO.staleStart = input["staleStart"] as? String
    RendererFixtureIO.exited = input["exited"] as? Bool == true
    RendererFixtureIO.allRecordedLive = input["allRecordedLive"] as? Bool == true
    RendererFixtureIO.processCalls = 0; RendererFixtureIO.recordOpens = 0; RendererFixtureIO.directorySyncs = 0
    RendererFixtureIO.syncError = RendererFixtureIO.errors[input["syncError"] as? String ?? ""] ?? 0
    func recoveryCheck() throws {
        recoveryChecks += 1
        clock += input["recoveryCheckDelay"] as? Double ?? 0
        if let limit = input["cancelAtRecoveryCheck"] as? Int, recoveryChecks >= limit { cancelled = true }
        if cancelled {
            if input["cancellationOnce"] as? Bool == true { cancelled = false }
            throw DriverFault("ACTION_UNSUPPORTED")
        }
    }
    var assistiveChanged = false
    let assistive = DriverRendererAssistiveProviders(state: { source in
        events.append("assistive:" + source)
        if input["liveUnknownAssistive"] as? Bool == true && ["voiceControl", "fullKeyboardAccess"].contains(source) {
            return try DriverRendererAssistiveProviders.live.state(source)
        }
        if assistiveChanged { return true }
        let state = (input["assistive"] as? DriverObject)?[source] ?? false
        if state as? String == "throws" { throw DriverFault("AX_UNAVAILABLE") }
        return driverBoolean(state)
    })
    let providers = DriverRendererProviders(identity: {
        events.append("identity")
        if ["identity-after-wait", "window-after-wait"].contains(fail) && clock >= 2 { throw DriverFault("IDENTITY_CHANGED") }
    }, processIdentity: {
        events.append("process-identity")
        if fail == "identity-after-wait" && clock >= 2 { throw DriverFault("IDENTITY_CHANGED") }
    }, read: { name in
        if fail == "probe-read" { throw DriverFault("AX_UNAVAILABLE") }
        let value = driverBoolean(attributes[name])
        if input["assistiveAfterRead"] as? Bool == true && clock >= 2 { assistiveChanged = true }
        if input["revokeAfterRead"] as? Bool == true && clock >= 2 { cancelled = true }
        events.append("read:\(name):\(value.map(String.init) ?? "unknown")")
        if fail == "readback" && !writes.isEmpty && !failedReadback {
            failedReadback = true; throw DriverFault("AX_UNAVAILABLE")
        }
        return value
    }, settable: { name in
        if fail == "probe-settable" { throw DriverFault("AX_UNAVAILABLE") }
        events.append("settable:" + name); return input["notSettable"] as? Bool != true
    }, write: { name, value in
        events.append("write:\(name):\(value)"); writes.append([name, value])
        if fail == "enable-before-write" && value { throw DriverFault("AX_UNAVAILABLE") }
        if value && input["ignoreEnable"] as? Bool != true { attributes[name] = true }
        if !value && !(fail == "restore" && name == "AXEnhancedUserInterface") { attributes[name] = false }
        if input["persistentApp"] as? Bool == true {
            try JSONSerialization.data(withJSONObject: attributes).write(to: URL(fileURLWithPath: appFile), options: .atomic)
        }
        if input["killAfterWrite"] as? Bool == true && value && (input["killAttribute"] == nil || input["killAttribute"] as? String == name) { raise(SIGKILL) }
        if input["holdForParentDeath"] as? Bool == true && value {
            fputs("renderer-write-ready\n", stderr); fflush(stderr)
            let end = ProcessInfo.processInfo.systemUptime + 5
            while getppid() == fixtureParent && ProcessInfo.processInfo.systemUptime < end { Thread.sleep(forTimeInterval: 0.01) }
        }
        // A provider can apply a write and then fail to acknowledge it.
        if fail == "enable" && value { throw DriverFault("AX_UNAVAILABLE") }
    }, remaining: { (input["remaining"] as? Double ?? 10) - clock }, wait: { duration in
        waits.append(duration); clock += duration
        if input["growTree"] as? Bool == true && attributes.values.contains(where: { driverBoolean($0) == true }) {
            let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
            for i in 0..<498 { rendererChildren?.add(["AXRole": i == 497 ? "AXTextArea" : "AXGroup",
                "AXTitle": i == 497 ? "Editor" : "Node", "frame": frame]) }
        }
        if let value = input["cleanupValue"], let name = input["cleanupAttribute"] as? String {
            attributes[name] = value
        }
        if fail == "wait" { throw DriverFault("AX_UNAVAILABLE") }
    }, processMatches: {
        !(fail == "identity-after-wait" && clock >= 2)
    }, assistive: assistive)
    do {
    let store: DriverRendererRestoreStore
    if input["startup"] as? Bool == true {
        store = try DriverRendererRestoreStore.startup(now: { clock })
    } else {
        store = try DriverRendererRestoreStore(stateDirectory: stateDirectory, now: { clock })
    }
    if let pids = input["armProcesses"] as? [Int] {
        try store.recover()
        for pid in pids {
            try store.arm(process: DriverRendererProcess(pid: pid, processStart: "1.2", bundleID: "test.fixture"),
                          attribute: "AXManualAccessibility")
        }
    }
    let lease = input["noLease"] as? Bool == true ? nil : DriverRendererLease(
        pid: input["wrongLease"] as? Bool == true ? 99 : 42, processStart: "1.2",
        bundleID: input["wrongBundleLease"] as? Bool == true ? "other.app" : bundleID, check: {
            events.append("lease")
            guard getppid() == fixtureParent else { throw DriverFault("IDENTITY_CHANGED") }
            if cancelled || fail == "lease" || fail == "lease-after-wait" && clock >= 2 { throw DriverFault("ACTION_UNSUPPORTED") }
        }, restoreStore: input["noOpCallbacks"] as? Bool == true ? nil : store, armRestore: { name in
            if input["noOpCallbacks"] as? Bool == true { return }
            events.append("arm:" + name)
            if fail == "arm" { throw DriverFault("AX_UNAVAILABLE") }
            pendingRestore.insert(name)
        }, confirmRestored: { name in
            if input["noOpCallbacks"] as? Bool == true { return }
            events.append("restored:" + name)
            if fail == "confirm" { throw DriverFault("AX_UNAVAILABLE") }
            if fail == "slow-confirm" { clock += 5 }
            pendingRestore.remove(name)
        })
    do {
        if input["lockConflict"] as? Bool == true {
            let other = try DriverRendererRestoreStore(stateDirectory: stateDirectory)
            var notes = [String]()
            let lockedLease = DriverRendererLease(pid: 42, processStart: "1.2", bundleID: "test.fixture", check: {},
                restoreStore: other, armRestore: { _ in }, confirmRestored: { _ in })
            _ = try DriverRenderer.read(lease: lockedLease, providers: providers, note: { notes.append($0) },
                inspect: { $0 }, walk: { _ in
                    walks += 1
                    return DriverRendererSnapshot(nodes: 11, hasField: false, truncated: false, depthLimited: false)
                })
            output["notes"] = notes
        } else if input["filteredScan"] as? Bool == true {
            output["consumed"] = try store.recover(leasedProcess: lease?.process, onlyProcess: lease?.process,
                deadline: clock + (input["recoveryBudget"] as? Double ?? 0.75), check: recoveryCheck)
        } else if input["recoverOnly"] as? Bool == true {
            output["consumed"] = try store.recover(leasedProcess: lease?.process,
                deadline: clock + (input["recoveryBudget"] as? Double ?? 0.75), check: recoveryCheck)
        } else if input["startup"] as? Bool == true {
            output["startupRecovery"] = store.recoveryReport.object
        } else if input["restoreFresh"] as? Bool == true {
            let service = DriverRendererService(store: store)
            let nonce = String(repeating: "a", count: 64)
            let envelope: DriverObject = ["lease": input["restoreLease"]!]
            let params: DriverObject = ["args": [envelope]]
            let object: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                "id": 1, "method": "rendererRestore", "params": params,
                "deadline": Int(Date().timeIntervalSince1970 * 1000) + 2000]
            let request = try DriverRequest(object, nonce: nonce, previous: 0)
            output["leaseEnd"] = try service.restore(request)
        } else if input["leaseEndOnly"] as? Bool == true {
            output["consumed"] = try store.recover(leasedProcess: lease?.process)
            try store.recover(onlyProcess: lease?.process)
        } else if input["deadlineCopy"] as? Bool == true {
            let nonce = String(repeating: "a", count: 64)
            let original = try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                "id": 1, "method": "getAXState", "params": [:],
                "deadline": Int(Date().timeIntervalSince1970 * 1000) + 1000], nonce: nonce, previous: 0)
            let retry = DriverRequest(copying: original, method: original.method, params: [:], reserving: 1.25)
            do { try retry.check(); output["retryAllowed"] = true }
            catch { output["retryAllowed"] = false }
            try original.check(); output["parentAllowed"] = true
            output["reserved"] = original.deadline - retry.deadline
        } else if input["adapter"] as? Bool == true || input["wire"] as? Bool == true {
            let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
            let role = input["secure"] as? Bool == true ? "AXSecureTextField" : input["field"] as? Bool == true ? "AXTextArea" : input["webRenderer"] as? Bool == true ? "AXWebArea" : "AXGroup"
            let children = NSMutableArray()
            for _ in 0..<(input["growTree"] as? Bool == true ? 10 : 1) {
                children.add(["AXRole": role, "AXTitle": "Renderer", "frame": frame])
            }
            rendererChildren = children
            let tree: DriverObject = ["AXRole": "AXWindow", "frame": frame, "AXTitle": "Fixture", "children": children]
            var fixture: DriverObject = ["apps": [], "windows": [["windowId": "7", "pid": 42,
                "processStart": "1.2", "bundleId": "test.fixture", "app": "Fixture", "title": "Fixture", "bounds": frame]], "trees": ["7": tree]]
            if input["menu"] as? Bool == true { fixture["menu"] = ["AXRole": "AXMenuBar", "frame": frame,
                "children": (0..<25).map { ["AXRole": "AXMenuBarItem", "AXTitle": "Item \($0)", "frame": frame] }] }
            let core = DriverCore(fixture: fixture)
            var binding: DriverObject = ["windowId": "7", "processStart": "1.2"]
            if let depth = input["depth"] { binding["depth"] = depth }
            if input["wire"] as? Bool == true {
                var envelope: DriverObject = [:]
                if input["omitRenderer"] as? Bool != true { envelope["renderer"] = input["renderer"] ?? true }
                if input["omitLease"] as? Bool != true {
                    let defaultLease: DriverObject = ["pid": 42, "processStart": "1.2", "bundleId": "test.fixture", "token": "fixture-token"]
                    envelope["lease"] = input["wireLease"] ?? defaultLease
                }
                binding["args"] = input["wireArgs"] ?? [envelope]
            }
            let nonce = String(repeating: "a", count: 64)
            let combined = input["combined"] as? Bool == true
            let request = try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
                "id": 1, "method": combined ? "getAXStateAndScreenshot" : "getAXState", "params": binding,
                "deadline": Int(Date().timeIntervalSince1970 * 1000) + 15000], nonce: nonce, previous: 0)
            var result: DriverObject
            if input["wire"] as? Bool == true {
                // Startup inventories durable records without AX access.
                try store.recover()
                let startupReport = store.recoveryReport.object
                let service = DriverRendererService(store: store, providers: { _, _ in providers })
                let runtime = DriverRuntime(core: core, nonce: nonce)
                runtime.registerRenderer(service: service, captureBackend: RendererFixtureCapture())
                result = try service.read(request, core: core,
                    capture: combined ? DriverCaptureService(backend: RendererFixtureCapture()) : nil)
                result["startupRecovery"] = startupReport
                result["methods"] = runtime.methods
                if input["wireEnd"] as? Bool == true {
                    let envelopes = binding["args"] as! [DriverObject]
                    let restoreIdentity = input["restoreLease"] ?? envelopes[0]["lease"]!
                    let restoreEnvelope: DriverObject = ["lease": restoreIdentity]
                    let restore = DriverRequest(copying: request, method: "rendererRestore",
                        params: ["args": [restoreEnvelope]])
                    result["leaseEnd"] = try service.restore(restore)
                }
            } else {
                result = try core.readRendererTree(binding, request: request, lease: lease,
                    providers: input["defaultProviders"] as? Bool == true ? nil : providers)
            }
            output = result; output["elements"] = core.maps["7"]?.elements.count
        } else {
            var notes = [String]()
            let result = try DriverRenderer.read(lease: lease, providers: providers, note: { notes.append($0) }, inspect: { $0 }, walk: { reserve in
                output["retryReserve"] = reserve
                walks += 1
                if fail == "second-walk" && walks == 3 { throw DriverFault("AX_UNAVAILABLE") }
                let active = (input["needsEnhanced"] as? Bool == true ? driverBoolean(attributes["AXEnhancedUserInterface"]) == true : attributes.values.contains { driverBoolean($0) == true }) && clock >= 2
                let expanded = walks > 1 && (input["expandOnWalk"] as? Bool == true || input["activatedTree"] as? Bool == true && active)
                return DriverRendererSnapshot(nodes: expanded ? 509 : input["nodes"] as? Int ?? 11,
                    hasField: expanded || input["field"] as? Bool == true, truncated: input["truncated"] as? Bool == true,
                    depthLimited: input["depthLimited"] as? Bool == true, webRenderer: input["webRenderer"] as? Bool == true)
            })
            output["nodes"] = result.nodes; output["notes"] = notes
        }
    } catch let fault as DriverFault { output["error"] = fault.code; output["unhealthy"] = fault.unhealthy }
    catch { output["error"] = "unexpected" }
    if input["recoverAfterRead"] as? Bool == true { output["ownConsumed"] = try store.recover() }
    output["recoveryReport"] = store.recoveryReport.object
    output["recoveryExit"] = store.recoveryReport.exitCode
    if input["health"] as? Bool == true {
        let core = DriverCore(fixture: [:]), nonce = String(repeating: "a", count: 64)
        let runtime = DriverRuntime(core: core, nonce: nonce)
        runtime.registerRenderer(service: DriverRendererService(store: store))
        let object: DriverObject = ["protocol": driverProtocol, "platform": "darwin", "nonce": nonce,
            "id": 1, "method": "health", "params": [:], "deadline": Int(Date().timeIntervalSince1970 * 1000) + 2000]
        let request = try DriverRequest(object, nonce: nonce, previous: 0)
        output["health"] = try runtime.handlers["health"]!(request, core)
    }
    if let lease = lease { output["canActivate"] = store.allowsActivation(lease.process) }
    } catch let fault as DriverFault { output["error"] = fault.code; output["unhealthy"] = fault.unhealthy; output["message"] = fault.message }
    catch { output["error"] = "unexpected" }
    output["records"] = (try? FileManager.default.contentsOfDirectory(atPath: stateDirectory + "/renderer-restore"))?.filter { $0.hasSuffix(".json") }.sorted() ?? []
    output["attributes"] = attributes; output["events"] = events
    output["rawAXWrites"] = RendererFixtureIO.rawAXWrites
    output["pendingRestore"] = pendingRestore.sorted()
    output["walks"] = walks; output["writes"] = writes; output["waits"] = waits
    output["clock"] = clock
    output["recordOpens"] = RendererFixtureIO.recordOpens; output["directorySyncs"] = RendererFixtureIO.directorySyncs
    output["processCalls"] = RendererFixtureIO.processCalls; output["recoveryChecks"] = recoveryChecks
    print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}
