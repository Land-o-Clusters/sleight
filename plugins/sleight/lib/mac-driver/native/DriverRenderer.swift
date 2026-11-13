import AppKit
import ApplicationServices

// Same-user undo data cannot prove who wrote the current attribute value.
struct DriverRendererProcess: Hashable {
    let pid: Int
    let processStart: String
    let bundleID: String
}

struct DriverRendererRestoreRecord: Codable, Equatable {
    let pid: Int
    let processStart: String
    let bundleID: String
    let attribute: String
    let original: Bool
    var recoveryReason: String? = nil
    enum CodingKeys: String, CodingKey { case pid, processStart, bundleID = "bundleId", attribute, original, recoveryReason }
    var process: DriverRendererProcess { DriverRendererProcess(pid: pid, processStart: processStart, bundleID: bundleID) }
    var filename: String { "renderer-\(pid)-\(processStart)-\(attribute).json" }
}

struct DriverRendererAssistiveProviders {
    // Only this read's own enable can be undone. Known running sources veto
    // that cleanup; unknown sources do not establish another writer.
    // Display preferences (Reduce Motion, Increase Contrast and the rest) don't set these attributes, so they
    // don't veto (sleight-arch, 2026-11-01): a veto there only denied undo to users with those settings.
    static let sources = ["voiceOver", "switchControl", "voiceControl", "fullKeyboardAccess", "knownTool"]
    let state: (String) throws -> Bool?

    func permitsCleanup() -> Bool {
        let states = Self.sources.map { try? state($0) }
        return !states.contains { $0 == true }
    }

    static let live = Self(state: { source in
        switch source {
        case "voiceOver": return NSWorkspace.shared.isVoiceOverEnabled
        case "switchControl": return NSWorkspace.shared.isSwitchControlEnabled
        case "knownTool":
            // Names are an incomplete conservative veto, never evidence that
            // assistive tools are absent or a basis for permitting cleanup.
            let names: Set<String> = ["VoiceOver", "Switch Control", "Voice Control", "Full Keyboard Access",
                                      "KeyStrokes", "SwitchXS", "Proloquo", "VisioVoice", "DwellClick", "Dragon"]
            let apps = NSWorkspace.shared.runningApplications
            for app in apps {
                if let name = app.localizedName, names.contains(name) { return true }
            }
            return false
        case "voiceControl", "fullKeyboardAccess":
            // No public global status query was found for these features.
            // NSApplication.isFullKeyboardAccessEnabled is keyboard navigation,
            // explicitly not the separate Accessibility Full Keyboard Access.
            // A missing NSWorkspace app is not proof a system service is off.
            return nil
        default: return nil
        }
    })
}

struct DriverRendererRecoveryReport {
    var restored = 0, retained = 0, skipped = 0, quarantined = 0, pruned = 0, failed = 0
    var reasonSaveFailed = 0
    var complete = false
    var remaining = [DriverObject]()
    var dropped = [DriverObject]()
    var exitCode: Int32 { complete && failed == 0 ? 0 : 1 }
    var object: DriverObject {
        var result: DriverObject = ["restored": restored, "retained": retained, "skipped": skipped, "quarantined": quarantined,
            "pruned": pruned, "failed": failed, "complete": complete, "remaining": remaining]
        if !dropped.isEmpty { result["dropped"] = dropped }
        if reasonSaveFailed > 0 { result["reasonSaveFailed"] = reasonSaveFailed }
        return result
    }
    mutating func retain(_ record: DriverRendererRestoreRecord, reason: String) {
        remaining.append(["pid": record.pid, "processStart": record.processStart, "bundleId": record.bundleID,
                          "attribute": record.attribute, "reason": reason])
    }
}

private enum DriverRendererRecordIO: Error { case unavailable, missing }

enum DriverRendererProcessState {
    case running(String), gone, unavailable

    static func inspect(_ pid: Int) -> Self {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        errno = 0
        let result = proc_pidinfo(pid_t(pid), PROC_PIDTBSDINFO, 0, &info, size)
        if result == size && info.pbi_start_tvsec > 0 {
            return .running("\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)")
        }
        return result <= 0 && errno == ESRCH ? .gone : .unavailable
    }
}

final class DriverRendererRestoreStore {
    private let directory: Int32
    private let lock: Int32
    let writable: Bool
    private let now: () -> Double
    private let processState: (Int) -> DriverRendererProcessState
    private(set) var recoveryReport = DriverRendererRecoveryReport()
    private var pending = Set<DriverRendererProcess>()
    private var scanned = false

    // Account metadata, not HOME or a tool parameter, selects the supervisor path.
    static func runtimeStateDirectory() throws -> String {
        guard let account = getpwuid(getuid()), let home = account.pointee.pw_dir else {
            throw DriverFault("INVALID_PARAMS", "Runtime account directory unavailable.")
        }
        return String(cString: home) + "/Library/Application Support/sleight/runtime"
    }

    static func startup(processState: @escaping (Int) -> DriverRendererProcessState = DriverRendererProcessState.inspect,
                        now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) throws -> DriverRendererRestoreStore {
        let path = try runtimeStateDirectory()
        let directory = try openDirectory(path, create: true)
        close(directory)
        let store = try DriverRendererRestoreStore(stateDirectory: path, processState: processState, now: now)
        // Startup only inventories and prunes. Records never authorize AX access.
        try store.recover()
        return store
    }

    private static func openDirectory(_ path: String, create: Bool = false) throws -> Int32 {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard path.hasPrefix("/"), parts.count > 1,
              !parts.dropFirst().contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.contains("\0") }) else {
            throw DriverFault("INVALID_PARAMS", "State directory must be an absolute resolved path.")
        }
        var fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw DriverFault("INVALID_PARAMS", "Cannot open state directory root.") }
        for part in parts.dropFirst() {
            if create {
                let created = mkdirat(fd, String(part), 0o700)
                guard created == 0 || errno == EEXIST else {
                    close(fd); throw DriverFault("AX_UNAVAILABLE", "Cannot create renderer recovery state directory.")
                }
                if created == 0 && fsync(fd) != 0 {
                    close(fd); throw DriverFault("AX_UNAVAILABLE", "Cannot sync renderer recovery state parent.")
                }
            }
            let child = openat(fd, String(part), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            close(fd)
            guard child >= 0 else { throw DriverFault("INVALID_PARAMS", "State directory has a symlink or inaccessible component.") }
            fd = child
        }
        return fd
    }

    private static func secureDirectory(_ fd: Int32, repair: Bool = false) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else {
            throw DriverFault("INVALID_PARAMS", "State directory must belong to the current user.")
        }
        // Only the runtime's own state path can receive this repair.
        if repair && info.st_mode & 0o7777 == 0o755 {
            guard fchmod(fd, 0o700) == 0, fstat(fd, &info) == 0 else {
                throw DriverFault("INVALID_PARAMS", "Cannot make state directory mode 0700.")
            }
        }
        guard info.st_mode & 0o7777 == 0o700 else {
            throw DriverFault("INVALID_PARAMS", "State directory must have mode 0700.")
        }
    }

    init(stateDirectory: String,
         processState: @escaping (Int) -> DriverRendererProcessState = DriverRendererProcessState.inspect,
         now: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) throws {
        let parent = try Self.openDirectory(stateDirectory)
        defer { close(parent) }
        try Self.secureDirectory(parent, repair: stateDirectory == (try Self.runtimeStateDirectory()))
        let created = mkdirat(parent, "renderer-restore", 0o700)
        guard created == 0 || errno == EEXIST else { throw DriverFault("INVALID_PARAMS", "Cannot create restore directory.") }
        let fd = openat(parent, "renderer-restore", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw DriverFault("INVALID_PARAMS", "Restore directory has a symlink or inaccessible component.") }
        var lockFD: Int32 = -1
        do {
            try Self.secureDirectory(fd)
            lockFD = openat(fd, ".lock", O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            var info = stat()
            guard lockFD >= 0, fstat(lockFD, &info) == 0, info.st_uid == getuid(),
                  info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o7777 == 0o600, info.st_nlink == 1 else {
                throw DriverFault("INVALID_PARAMS", "Unsafe renderer restore lock.")
            }
            // A competing session disables mutation here, not the whole helper.
            let until = ProcessInfo.processInfo.systemUptime + 0.1
            var owns = false
            while true {
                if flock(lockFD, LOCK_EX | LOCK_NB) == 0 { owns = true; break }
                guard errno == EWOULDBLOCK else { throw DriverFault("INVALID_PARAMS", "Cannot lock renderer restore directory.") }
                if ProcessInfo.processInfo.systemUptime >= until { break }
                Thread.sleep(forTimeInterval: 0.01)
            }
            guard fsync(parent) == 0 else { throw DriverFault("INVALID_PARAMS", "Cannot sync state directory.") }
            directory = fd; lock = lockFD; writable = owns; self.now = now
            self.processState = processState
        } catch { if lockFD >= 0 { close(lockFD) }; close(fd); throw error }
    }

    deinit { close(lock); close(directory) }

    private func validate(_ record: DriverRendererRestoreRecord) throws {
        guard record.pid > 0, record.pid <= Int(Int32.max),
              record.processStart.range(of: "\\A[0-9]+[.][0-9]+\\z", options: .regularExpression) != nil,
              record.processStart.utf8.count <= 64,
              record.bundleID.range(of: "\\A[A-Za-z0-9._+-]{1,255}\\z", options: .regularExpression) != nil,
              DriverRenderer.attributes.contains(record.attribute), !record.original else { throw DriverFault("INVALID_PARAMS") }
        if let reason = record.recoveryReason, !Self.retentionReasons.contains(reason) { throw DriverFault("INVALID_PARAMS") }
    }

    static let retentionReasons: Set<String> = ["assistive-technology-running", "value-changed-since", "identity-changed",
        "lease-unavailable", "recovery-disabled"]

    func allowsActivation(_ process: DriverRendererProcess) -> Bool {
        let record = DriverRendererRestoreRecord(pid: process.pid, processStart: process.processStart, bundleID: process.bundleID,
                                                attribute: DriverRenderer.attributes[0], original: false)
        // This must precede the parent's armRestore callback, including on a read
        // whose unmodified tree is otherwise valid.
        guard (try? validate(record)) != nil else { return false }
        return writable && scanned && !pending.contains(process)
    }

    func arm(process: DriverRendererProcess, attribute: String) throws {
        guard allowsActivation(process) else { throw DriverFault("AX_UNAVAILABLE") }
        let record = DriverRendererRestoreRecord(pid: process.pid, processStart: process.processStart, bundleID: process.bundleID,
                                                attribute: attribute, original: false)
        try validate(record)
        var info = stat()
        guard fstatat(directory, record.filename, &info, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else {
            throw DriverFault("AX_UNAVAILABLE")
        }
        try save(record)
    }

    private var scanDirty = false
    private var scanning = false

    private func save(_ record: DriverRendererRestoreRecord) throws {
        let temporary = ".pending-" + UUID().uuidString
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
        defer { close(fd); unlinkat(directory, temporary, 0) }
        let data = try JSONEncoder().encode(record)
        let written = data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        guard written == data.count, fsync(fd) == 0,
              renameat(directory, temporary, directory, record.filename) == 0 else {
            throw DriverFault("DRIVER_INTERNAL", unhealthy: true)
        }
        if scanning { scanDirty = true }
        else if fsync(directory) != 0 { throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
    }

    func keep(process: DriverRendererProcess, attribute: String, reason: String) throws {
        let record = try load(DriverRendererRestoreRecord(pid: process.pid, processStart: process.processStart,
            bundleID: process.bundleID, attribute: attribute, original: false).filename)
        retain(record, reason: reason)
    }

    private func retain(_ record: DriverRendererRestoreRecord, reason: String) {
        pending.insert(record.process)
        recoveryReport.retain(record, reason: reason)
        if Self.retentionReasons.contains(reason) {
            recoveryReport.retained += 1
            guard record.recoveryReason != reason else { return }
            var saved = record; saved.recoveryReason = reason
            // A failed diagnostic update never authorizes AX, removes undo or
            // turns a deliberately retained leftover into an unsafe lease end.
            do { try save(saved) } catch { recoveryReport.reasonSaveFailed += 1 }
        } else { recoveryReport.failed += 1 }
    }

    func confirm(process: DriverRendererProcess, attribute: String) throws {
        guard writable else { throw DriverFault("AX_UNAVAILABLE") }
        let record = DriverRendererRestoreRecord(pid: process.pid, processStart: process.processStart, bundleID: process.bundleID,
                                                attribute: attribute, original: false)
        try validate(record)
        guard unlinkat(directory, record.filename, 0) == 0, fsync(directory) == 0 else {
            throw DriverFault("DRIVER_INTERNAL", unhealthy: true)
        }
    }

    private func recordIOFailure(_ code: Int32) -> Error {
        if [EMFILE, ENFILE, EINTR, EAGAIN].contains(code) { return DriverRendererRecordIO.unavailable }
        return DriverFault("INVALID_PARAMS")
    }

    private func load(_ name: String) throws -> DriverRendererRestoreRecord {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard fd >= 0 else {
            if errno == ENOENT { throw DriverRendererRecordIO.missing }
            throw recordIOFailure(errno)
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0 else { throw recordIOFailure(errno) }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_mode & 0o7777 == 0o600, info.st_nlink == 1, info.st_size > 0, info.st_size <= 1024 else {
            throw DriverFault("INVALID_PARAMS")
        }
        var bytes = [UInt8](repeating: 0, count: 1025)
        let size = Darwin.read(fd, &bytes, bytes.count)
        guard size >= 0 else { throw recordIOFailure(errno) }
        guard size == info.st_size, size <= 1024 else { throw DriverFault("INVALID_PARAMS") }
        let data = Data(bytes.prefix(size))
        var object = try DriverJSON.decode(data)
        // Read RTW2B's spelling once, but all new records and reports use bundleId.
        if object["bundleId"] == nil, let legacy = object.removeValue(forKey: "bundleID") { object["bundleId"] = legacy }
        let required: Set<String> = ["pid", "processStart", "bundleId", "attribute", "original"]
        guard Set(object.keys) == required || Set(object.keys) == required.union(["recoveryReason"]) else { throw DriverFault("INVALID_PARAMS") }
        if object["recoveryReason"] != nil, !(object["recoveryReason"] is String) { throw DriverFault("INVALID_PARAMS") }
        let record = try JSONDecoder().decode(DriverRendererRestoreRecord.self,
            from: JSONSerialization.data(withJSONObject: object))
        try validate(record)
        guard record.filename == name else { throw DriverFault("INVALID_PARAMS") }
        return record
    }

    // Use an fd-relative enumeration even if an ancestor is renamed after init.
    // Records only inventory leftovers. This scan has no AX providers or writes.
    @discardableResult func recover(leasedProcess: DriverRendererProcess? = nil, onlyProcess: DriverRendererProcess? = nil, deadline: Double? = nil,
                                    check: () throws -> Void = {}) throws -> Int {
        scanned = false
        recoveryReport = DriverRendererRecoveryReport()
        pending.removeAll()
        try check()
        guard writable else { return 0 } // No AX, rename, deletion or activation under someone else's lock.
        let end = min(deadline ?? now() + 0.75, now() + 0.75)
        let scanFD = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard scanFD >= 0, let stream = fdopendir(scanFD) else {
            if scanFD >= 0 { close(scanFD) }; recoveryReport.failed += 1; return 0
        }
        scanning = true; scanDirty = false
        defer {
            closedir(stream)
            scanning = false
            // Include successful mutations before timeout or cancellation.
            if scanDirty && fsync(directory) != 0 {
                recoveryReport.failed += 1; recoveryReport.complete = false; scanned = false
            }
        }
        let consumed = 0
        var scanFailed = false
        while true {
            try check()
            guard now() < end else { recoveryReport.failed += 1; return consumed }
            errno = 0
            guard let entry = readdir(stream) else {
                if errno != 0 { recoveryReport.failed += 1; scanFailed = true }
                break
            }
            let nameCapacity = Int(entry.pointee.d_namlen) + 1
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: nameCapacity) { String(cString: $0) }
            }
            guard name.hasPrefix("renderer-") else { continue }
            // Filename identity bounds lease-end I/O before open/fstat/read.
            if let process = onlyProcess {
                let names = DriverRenderer.attributes.map {
                    "renderer-\(process.pid)-\(process.processStart)-\($0).json"
                }
                guard names.contains(name) else { continue }
            }
            let record: DriverRendererRestoreRecord
            do { record = try load(name) }
            catch DriverRendererRecordIO.missing { recoveryReport.skipped += 1; continue }
            catch DriverRendererRecordIO.unavailable {
                // Resource pressure and interrupted I/O do not invalidate undo.
                recoveryReport.failed += 1; scanFailed = true; continue
            }
            catch {
                try check()
                guard now() < end else { recoveryReport.failed += 1; return consumed }
                // Keep the exact bad entry (including links and directories) for diagnosis.
                if renameat(directory, name, directory, ".quarantine-" + UUID().uuidString) == 0 {
                    recoveryReport.quarantined += 1
                    scanDirty = true
                } else { recoveryReport.failed += 1; scanFailed = true }
                continue
            }
            let state = processState(record.pid)
            try check()
            guard now() < end else { recoveryReport.failed += 1; recoveryReport.retain(record, reason: "deadline"); return consumed }
            switch state {
            case .running(let start) where start == record.processStart:
                break
            case .gone, .running:
                // Exit or a different kernel start means the attribute went
                // with the old process. Pruning never reads or writes AX.
                if unlinkat(directory, name, 0) == 0 {
                    recoveryReport.pruned += 1
                    scanDirty = true
                } else {
                    recoveryReport.retain(record, reason: "remove-failed")
                    recoveryReport.failed += 1; scanFailed = true
                }
                continue
            case .unavailable:
                recoveryReport.retain(record, reason: "process-unavailable")
                recoveryReport.failed += 1; scanFailed = true; continue
            }
            try check()
            guard now() < end else { recoveryReport.failed += 1; return consumed }
            if let leased = leasedProcess, record.pid == leased.pid, record.processStart == leased.processStart {
                // A conflicting bundle at the same kernel identity also blocks activation.
                pending.insert(leased)
            }
            retain(record, reason: record.recoveryReason ?? "recovery-disabled")
        }
        scanned = !scanFailed
        recoveryReport.complete = !scanFailed
        return consumed
    }
}

// The parent constructs this only after approval and acquisition of the window
// lease. The parent renews it at send. A crash or parent death leaves records
// for inventory and pruning; the next helper never writes AX from a record.
struct DriverRendererLease {
    let pid: Int
    let processStart: String
    let bundleID: String
    let check: () throws -> Void
    var restoreStore: DriverRendererRestoreStore? = nil
    let armRestore: (String) throws -> Void
    let confirmRestored: (String) throws -> Void

    var process: DriverRendererProcess { DriverRendererProcess(pid: pid, processStart: processStart, bundleID: bundleID) }

}

struct DriverRendererSnapshot {
    let nodes: Int
    let hasField: Bool
    let truncated: Bool
    let depthLimited: Bool
    var webRenderer: Bool = false
    var thin: Bool { nodes > 0 && nodes <= 20 && !hasField && !truncated && !depthLimited }
    var verdict: DriverObject { ["web": webRenderer, "thin": thin, "complete": !truncated && !depthLimited] }
}

struct DriverRendererProviders {
    // The helper checks its request and parent binding, plus process identity.
    // These AX calls must each have their own bounded messaging timeout.
    let identity: () throws -> Void
    let processIdentity: () throws -> Void
    let read: (String) throws -> Bool?
    let settable: (String) throws -> Bool
    let write: (String, Bool) throws -> Void
    let remaining: () -> Double
    let wait: (Double) throws -> Void
    var processMatches: (() throws -> Bool)? = nil
    var assistive: DriverRendererAssistiveProviders = .live
}

enum DriverRenderer {
    static let attributes = ["AXManualAccessibility", "AXEnhancedUserInterface"]
    // Two attributes, each with a 250 ms write and readback, plus reply time.
    static let cleanupReserve = 1.25

    static func read<T>(lease: DriverRendererLease?, providers: DriverRendererProviders,
                        note: (String) -> Void = { _ in },
                        changed: (String) -> Void = { _ in },
                        inspect: (T) -> DriverRendererSnapshot, walk: (Double) throws -> T) throws -> T {
        func check() throws {
            if let lease = lease {
                guard lease.pid > 0, !lease.processStart.isEmpty, !lease.bundleID.isEmpty else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-lease") }
                try lease.check()
            }
            try providers.identity()
        }
        // Inventory crash leftovers before this helper can produce new mutations.
        try check()
        try lease?.restoreStore?.recover(leasedProcess: lease?.process,
            deadline: ProcessInfo.processInfo.systemUptime + max(0, min(0.75, providers.remaining())), check: check)
        try check()
        let first = try walk(0)
        try check()
        guard inspect(first).thin else { return first }
        try check()
        var result = try walk(0) // Both attributes remain untouched on the plain retry.
        try check()
        guard inspect(result).thin else { return result }
        guard let lease = lease, let store = lease.restoreStore, store.allowsActivation(lease.process) else {
            note("activation-recovery-unavailable"); return result
        }
        var armed = [String](), attempted = Set<String>(), failure: Error?
        do {
            for name in attributes {
                guard inspect(result).thin else { break }
                if name == attributes[1] && !inspect(result).webRenderer { continue }
                try check()
                let original: Bool?, settable: Bool
                do {
                    original = try providers.read(name)
                    try check()
                    settable = original == false ? try providers.settable(name) : false
                } catch let fault as DriverFault where fault.code == "AX_UNAVAILABLE" && attempted.isEmpty {
                    try check(); note("activation-probe-failed"); return result
                }
                guard original == false, settable else { continue }
                try check()
                // Include the walk as well as write/readback, wait and cleanup.
                guard providers.remaining() >= 2 + cleanupReserve + 0.5 + 1 else {
                    note("activation-budget-skipped"); continue
                }
                try lease.armRestore(name)
                try store.arm(process: lease.process, attribute: name)
                armed.append(name)
                try check()
                guard providers.remaining() >= 2 + cleanupReserve + 0.5 + 1 else { throw DriverFault("DEADLINE_EXCEEDED") }
                attempted.insert(name)
                try providers.write(name, true)
                try check()
                if try providers.read(name) == true {
                    changed(name)
                    guard providers.remaining() >= 2 + cleanupReserve + 1 else { throw DriverFault("DEADLINE_EXCEEDED") }
                    try providers.wait(2)
                }
                try check()
                guard providers.remaining() > cleanupReserve else { throw DriverFault("DEADLINE_EXCEEDED") }
                result = try walk(cleanupReserve)
                try check()
            }
            try check()
        } catch { failure = error }

        var cleanupFailed = false
        var cleaned = [String]()
        for name in armed.reversed() {
            func keep(_ reason: String) throws {
                try store.keep(process: lease.process, attribute: name, reason: reason)
                note("activation-cleanup-retained:" + reason)
            }
            do {
                // An armed record alone never grants permission to write AX.
                guard attempted.contains(name) else { cleaned.append(name); continue }
                // The request callback checks deadline, parent and window binding.
                do { try check() }
                catch { try keep("lease-unavailable"); continue }
                if let matches = providers.processMatches, try !matches() {
                    try keep("identity-changed"); continue
                }
                try providers.processIdentity()
                let current = try providers.read(name)
                // A rejected or ignored enable may leave the original false.
                // Forget that record without issuing an unnecessary undo write.
                if current == false { cleaned.append(name); continue }
                guard current == true else {
                    try keep("value-changed-since"); continue
                }
                guard providers.assistive.permitsCleanup() else {
                    try keep("assistive-technology-running"); continue
                }
                // Recheck authorization and process after the value and assistive probes.
                do { try check() }
                catch { try keep("lease-unavailable"); continue }
                if let matches = providers.processMatches, try !matches() {
                    try keep("identity-changed"); continue
                }
                try providers.processIdentity()
                try providers.write(name, false)
                if let matches = providers.processMatches, try !matches() { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-process") }
                try providers.processIdentity()
                guard try providers.read(name) == false else { throw DriverFault("AX_UNAVAILABLE") }
                cleaned.append(name)
            } catch { cleanupFailed = true }
        }
        // Confirm only attributes this read actually restored. Policy retention
        // leaves its record intact and is separate from an AX or I/O failure.
        if !cleanupFailed {
            for name in cleaned {
                do {
                    try lease.confirmRestored(name)
                    try store.confirm(process: lease.process, attribute: name)
                } catch { cleanupFailed = true }
            }
        }
        if cleanupFailed { throw DriverFault("DRIVER_INTERNAL", unhealthy: true) }
        if let failure = failure { throw failure }
        if inspect(result).thin { note("tree-still-thin") }
        return result
    }
}

extension DriverCore {
    func rendererSnapshot(_ result: DriverObject, params: DriverObject) -> DriverRendererSnapshot {
        guard let id = params["windowId"] as? String, let read = driverInteger(result["readId"]),
              let map = maps[id], map.id == read else {
            return DriverRendererSnapshot(nodes: 0, hasField: false, truncated: true, depthLimited: false)
        }
        // A large menu bar must not disguise a thin renderer window.
        let nodes = map.elements.values.filter { $0.root.same(map.root) }
        let fields: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSecureTextField", "AXSearchField"]
        return DriverRendererSnapshot(nodes: nodes.count, hasField: nodes.contains { fields.contains($0.role) || $0.secure },
            truncated: map.truncated, depthLimited: (driverInteger(params["depth"]) ?? 64) < 64,
            webRenderer: nodes.contains { ["AXWebArea", "AXHTMLContent"].contains($0.role) })
    }
    // RT8 calls this from its leased read path. Raw readTree stays unchanged.
    // Providers are internal dependencies, never caller-controlled tool params.
    func readRendererTree(_ params: DriverObject, request: DriverRequest, lease: DriverRendererLease?,
                          providers injected: DriverRendererProviders? = nil) throws -> DriverObject {
        if params["reuseIfUnchanged"] == nil, let id = params["windowId"] as? String { maps.removeValue(forKey: id) }
        try request.check()
        try session.checkBeforeDesktop(allowLocked: request.allowLocked)
        let bound = try boundWindow(params, request: request)
        guard let pid = driverInteger(bound.window["pid"]), let start = bound.window["processStart"] as? String,
              let id = bound.window["windowId"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-window") }
        if let lease = lease {
            guard lease.pid == pid, lease.processStart == start,
                  lease.bundleID == bound.window["bundleId"] as? String else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-lease") }
        }
        let authorization = lease.map { original in
            DriverRendererLease(pid: original.pid, processStart: original.processStart, bundleID: original.bundleID, check: {
                try request.check(); try original.check()
            }, restoreStore: original.restoreStore, armRestore: original.armRestore, confirmRestored: original.confirmRestored)
        }
        let providers = injected ?? rendererProviders(bound, request: request, lease: authorization)
        // Even an injected AX provider cannot bypass the adapter's binding check.
        let checked = DriverRendererProviders(identity: {
            _ = try self.inventory.recheck(bound.window)
            try providers.identity()
        }, processIdentity: providers.processIdentity, read: providers.read, settable: providers.settable, write: providers.write,
            remaining: { min(request.remaining, providers.remaining()) }, wait: providers.wait, processMatches: providers.processMatches,
            assistive: providers.assistive)
        do {
            var notes = [String](), changed = false
            func snapshot(_ result: DriverObject) -> DriverRendererSnapshot {
                self.rendererSnapshot(result, params: params)
            }
            var result: DriverObject = try DriverRenderer.read(lease: authorization, providers: checked, note: { notes.append($0) },
                changed: { _ in changed = true }, inspect: snapshot, walk: { reserve in
                try request.check()
                try lease?.check()
                let retry = reserve > 0 ? DriverRequest(copying: request, method: request.method,
                    params: params, reserving: reserve) : request
                // The earlier deadline covers binding and final checks as well
                // as the walk, including the AX per-call timeout slices.
                try retry.check()
                return try self.readTree(params, request: retry)
            })
            if !notes.isEmpty { result["rendererNotes"] = notes }
            result["rendererAttributeChanged"] = changed
            // Observation only, derived from the final retained window map.
            // A missing web role is not proof that an app is native.
            result["renderer"] = snapshot(result).verdict
            return result
        } catch {
            maps.removeValue(forKey: id)
            throw error
        }
    }

    private func rendererProviders(_ bound: DriverBoundWindow, request: DriverRequest, lease: DriverRendererLease?) -> DriverRendererProviders {
        // Fixture mode must never accidentally create an AX handle for a real PID.
        let app = inventory.fixture == nil ? AXUIElementCreateApplication(pid_t(driverInteger(bound.window["pid"])!)) : nil
        func timeout() { if let app = app { AXUIElementSetMessagingTimeout(app, 0.25) } }
        let processIdentity = { () throws -> Void in
            if let app = app {
                var pid: pid_t = 0
                guard AXUIElementGetPid(app, &pid) == .success,
                      Int(pid) == driverInteger(bound.window["pid"]),
                      driverStart(pid) == bound.window["processStart"] as? String,
                      NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bound.window["bundleId"] as? String else {
                    throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-process")
                }
            }
        }
        return DriverRendererProviders(identity: processIdentity, processIdentity: processIdentity, read: { name in
            guard let app = app else { return nil }
            timeout(); var value: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(app, name as CFString, &value)
            if status == .attributeUnsupported || status == .noValue { return nil }
            guard status == .success else { throw DriverFault("AX_UNAVAILABLE") }
            return driverBoolean(value)
        }, settable: { name in
            guard let app = app else { return false }
            timeout(); var value = DarwinBoolean(false)
            let status = AXUIElementIsAttributeSettable(app, name as CFString, &value)
            if status == .attributeUnsupported { return false }
            guard status == .success else { throw DriverFault("AX_UNAVAILABLE") }
            return value.boolValue
        }, write: { name, value in
            guard let app = app else { throw DriverFault("AX_UNAVAILABLE") }
            timeout()
            guard AXUIElementSetAttributeValue(app, name as CFString, value ? kCFBooleanTrue : kCFBooleanFalse) == .success else {
                throw DriverFault("AX_UNAVAILABLE")
            }
        }, remaining: { request.remaining }, wait: { duration in
            let end = ProcessInfo.processInfo.systemUptime + duration
            while ProcessInfo.processInfo.systemUptime < end {
                try request.check(); try lease?.check()
                guard request.remaining > DriverRenderer.cleanupReserve else { throw DriverFault("DEADLINE_EXCEEDED") }
                Thread.sleep(forTimeInterval: max(0, min(0.025, end - ProcessInfo.processInfo.systemUptime)))
            }
        }, processMatches: {
            guard self.inventory.fixture == nil else { return true }
            let pid = pid_t(driverInteger(bound.window["pid"])!)
            return driverStart(pid) == bound.window["processStart"] as? String &&
                NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == bound.window["bundleId"] as? String
        })
    }
}

// One service per authenticated helper. Tokens identify parent-held leases;
// durable files only inventory leftovers and never substitute for authority.
final class DriverRendererService {
    let store: DriverRendererRestoreStore?
    private let parent = getppid()
    private var leases: [String: DriverRendererWireLease] = [:]
    private let providers: ((DriverBoundWindow, DriverRequest) -> DriverRendererProviders)?

    init(store: DriverRendererRestoreStore?,
         providers: ((DriverBoundWindow, DriverRequest) -> DriverRendererProviders)? = nil) {
        self.store = store; self.providers = providers
    }

    func read(_ request: DriverRequest, core: DriverCore, capture: DriverCaptureService? = nil) throws -> DriverObject {
        let combined = request.method == "getAXStateAndScreenshot"
        var optional: Set<String> = ["depth", "budgetMs", "args", "reuseIfUnchanged", "menuRequests"]
        if combined { optional.formUnion(["format", "scale"]) }
        try request.keys(["windowId", "processStart"], optional: optional)
        let enabled = request.params["args"] != nil
        var params = request.params
        params.removeValue(forKey: "args")
        let clean = DriverRequest(copying: request, method: request.method, params: params)
        var lease: DriverRendererLease?
        var bound: DriverBoundWindow?
        if enabled {
            let envelope = try DriverRendererWireLease.envelope(request.params, read: true)
            let wire = try DriverRendererWireLease(envelope["lease"])
            let window = try core.boundWindow(params, request: clean)
            func check() throws {
                try clean.check()
                guard self.parent > 1, getppid() == self.parent else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-parent") }
                let current = try core.inventory.recheck(window.window)
                guard driverInteger(current["pid"]) == wire.pid,
                      current["processStart"] as? String == wire.processStart,
                      current["bundleId"] as? String == wire.bundleID else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-window") }
                if core.inventory.fixture == nil {
                    guard driverStart(pid_t(wire.pid)) == wire.processStart,
                          NSRunningApplication(processIdentifier: pid_t(wire.pid))?.bundleIdentifier == wire.bundleID else {
                        throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-process")
                    }
                }
            }
            try check()
            if let prior = leases[wire.token], prior != wire { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-token") }
            leases[wire.token] = wire
            lease = DriverRendererLease(pid: wire.pid, processStart: wire.processStart, bundleID: wire.bundleID,
                check: check, restoreStore: store, armRestore: { _ in try check() }, confirmRestored: { _ in })
            bound = window
        }
        let injectedProviders: DriverRendererProviders?
        if let bound = bound { injectedProviders = providers?(bound, clean) } else { injectedProviders = nil }
        let tree: () throws -> DriverObject = {
            if enabled {
                return try core.readRendererTree(params, request: clean, lease: lease,
                    providers: injectedProviders)
            }
            var result = try core.readTree(params, request: clean)
            result["renderer"] = core.rendererSnapshot(result, params: params).verdict
            return result
        }
        do {
            if let capture = capture {
                return try capture.read(request: clean, combined: true,
                    bind: { try core.boundWindow(params, request: clean).window }, tree: tree)
            }
            return try tree()
        } catch {
            if let id = params["windowId"] as? String { core.maps.removeValue(forKey: id) }
            throw error
        }
    }

    func restore(_ request: DriverRequest) throws -> DriverObject {
        try request.keys(["args"])
        let wire = try DriverRendererWireLease(DriverRendererWireLease.envelope(request.params, read: false)["lease"])
        if let prior = leases[wire.token], prior != wire { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=renderer-token") }
        guard let store = store, store.writable else {
            // Neither case can arm a write in this service, so there is no undo to await.
            leases.removeValue(forKey: wire.token)
            return ["restored": true, "retained": 0, "token": wire.token, "recovery": ["available": false]]
        }
        let process = DriverRendererProcess(pid: wire.pid, processStart: wire.processStart, bundleID: wire.bundleID)
        // Ordinary in-read cleanup undoes this helper's own writes. Leftover
        // records retained by policy are separate from failed restoration and
        // cannot make the parent's lease ending unsafe.
        try store.recover(leasedProcess: process, onlyProcess: process,
            deadline: ProcessInfo.processInfo.systemUptime + min(0.75, request.remaining), check: { try request.check() })
        let restored = store.recoveryReport.complete && store.recoveryReport.failed == 0
        if restored { leases.removeValue(forKey: wire.token) }
        return ["restored": restored, "retained": store.recoveryReport.retained,
                "token": wire.token, "recovery": store.recoveryReport.object]
    }
}

extension DriverRuntime {
    func registerRenderer(service injected: DriverRendererService? = nil, captureBackend: DriverCaptureBackend? = nil,
                          startup: (() throws -> DriverRendererRestoreStore)? = nil) {
        // Fixture startup cannot create or inspect the owner's runtime bank.
        var store: DriverRendererRestoreStore?
        if injected == nil && (core.inventory.fixture == nil || startup != nil) {
            do { store = try startup?() ?? DriverRendererRestoreStore.startup() }
            catch { fputs("sleight: renderer recovery state unavailable; activation disabled.\n", stderr) }
        }
        let service = injected ?? DriverRendererService(store: store)
        register(method: "health") { request, core in
            try request.keys([])
            var result = core.health(); result["methods"] = self.methods
            result["rendererRecovery"] = service.store?.recoveryReport.object ?? ["available": false]
            return result
        }
        if let report = store?.recoveryReport, report.retained > 0 || report.failed > 0 || !report.complete || !report.dropped.isEmpty {
            if let data = try? JSONSerialization.data(withJSONObject: report.object, options: [.sortedKeys]),
               let text = String(data: data, encoding: .utf8) { fputs("sleight: renderer recovery: \(text)\n", stderr) }
        }
        let capture = DriverCaptureService(backend: captureBackend ?? DriverWindowCaptureBackend())
        register(method: "getAXState") { request, core in try service.read(request, core: core) }
        register(method: "getAXStateAndScreenshot") { request, core in
            if core.inventory.fixture != nil && captureBackend == nil { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
            return try service.read(request, core: core, capture: capture)
        }
        register(method: "rendererRestore") { request, _ in try service.restore(request) }
    }
}

// Internal inventory-only mode, with no desktop loop or AX access. Normal
// helper startup also inventories records. No termination supervisor is installed.
func driverRestoreRendererMain() {
    guard CommandLine.arguments.dropFirst().first == "--restore-renderer" else { return }
    do {
        guard CommandLine.arguments.count == 3,
              CommandLine.arguments[2] == (try DriverRendererRestoreStore.runtimeStateDirectory()) else {
            throw DriverFault("INVALID_PARAMS", "Recovery requires the runtime's own state directory.")
        }
        let store = try DriverRendererRestoreStore(stateDirectory: CommandLine.arguments[2])
        try store.recover()
        print(String(data: try JSONSerialization.data(withJSONObject: store.recoveryReport.object,
                                                    options: [.sortedKeys]), encoding: .utf8)!)
        exit(store.recoveryReport.exitCode)
    } catch let fault as DriverFault {
        let result: DriverObject = ["error": fault.code, "message": fault.message, "unhealthy": fault.unhealthy]
        print(String(data: try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
        exit(1)
    } catch {
        print("{\"error\":\"INVALID_PARAMS\",\"unhealthy\":false}")
        exit(1)
    }
}
