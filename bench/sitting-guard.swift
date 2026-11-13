import AppKit
import ApplicationServices
import Carbon
import Darwin
import IOKit
import IOKit.hid

// Owner-present admission uses only fd and process metadata, never window APIs.
// The allow-list deliberately requires Apple's local Terminal and ordinary shells.
func ownerTerminalAccepted(_ row: [String: Any]) -> Bool {
    guard row["stdinTTY"] as? Bool == true, row["sameTTY"] as? Bool == true,
          row["foreground"] as? Bool == true, row["local"] as? Bool == true,
          let chain = row["chain"] as? [[String: Any]], !chain.isEmpty, chain.count <= 32 else { return false }
    let terminals = ["/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
                     "/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal"]
    let shells = ["/bin/zsh", "/bin/bash", "/bin/sh", "/bin/ksh", "/bin/csh", "/bin/tcsh", "/usr/bin/login", "/usr/bin/env", "/usr/bin/nice"]
    for (index, process) in chain.enumerated() {
        guard let path = process["path"] as? String else { return false }
        if terminals.contains(path) { return index == chain.count - 1 && index > 0 }
        if !shells.contains(path) || process["sameTTY"] as? Bool != true { return false }
    }
    return false
}
struct OwnerTerminalProcess {
    let parent: pid_t, tty: UInt32, path: String
}
struct OwnerTerminalSource {
    var openTTY: () -> Int32 = { Darwin.open("/dev/tty", O_RDONLY | O_NOCTTY) }
    var closeTTY: (Int32) -> Void = { _ = Darwin.close($0) }
    var device: (Int32) -> dev_t? = { fd in var info = stat(); return fstat(fd, &info) == 0 ? info.st_rdev : nil }
    // proc_pidinfo refuses root-owned processes such as Terminal's `login -pf` (EPERM, measured 2026-11-07),
    // so the parent and tty come from the kernel's process table, which any user may read.
    var process: (pid_t) -> OwnerTerminalProcess? = { pid in
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        var kinfo = kinfo_proc(), length = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &kinfo, &length, nil, 0) == 0, length == MemoryLayout<kinfo_proc>.stride,
              kinfo.kp_proc.p_pid == pid, proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return nil }
        return OwnerTerminalProcess(parent: kinfo.kp_eproc.e_ppid, tty: UInt32(bitPattern: kinfo.kp_eproc.e_tdev),
                                    path: String(cString: path))
    }
    var runnerPID: () -> pid_t = { getppid() }
    var stdinTTY: () -> Bool = { isatty(STDIN_FILENO) == 1 }
    var foregroundGroup: (Int32) -> pid_t = { tcgetpgrp($0) }
    var processGroup: () -> pid_t = { getpgrp() }
    var environment: () -> [String: String] = { ProcessInfo.processInfo.environment }
}
// Tests replace only metadata providers. The collector and its comparisons are
// the same ones the non-drawing verifier uses for the real descriptors.
func ownerTerminalMetadata(_ source: OwnerTerminalSource = OwnerTerminalSource()) -> [String: Any] {
    let fd = source.openTTY()
    defer { if fd >= 0 { source.closeTTY(fd) } }
    let input = source.device(STDIN_FILENO)
    let runner = source.process(source.runnerPID())
    let valid = fd >= 0 && input != nil && runner != nil
    var chain: [[String: Any]] = [], pid = runner?.parent ?? 0
    for _ in 0..<32 {
        guard pid > 1, let info = source.process(pid) else { break }
        chain.append(["path": info.path, "sameTTY": info.tty == runner?.tty])
        if info.path.hasSuffix("/Terminal.app/Contents/MacOS/Terminal") { break }
        pid = info.parent
    }
    let env = source.environment()
    return ["stdinTTY": source.stdinTTY(),
        // /dev/tty's st_rdev identifies the alias device. The kernel process
        // table supplies the runner's actual controlling tty (-1 means none).
        "sameTTY": valid && runner?.tty != UInt32.max && UInt32(truncatingIfNeeded: input ?? 0) == runner?.tty,
        "foreground": valid && source.foregroundGroup(fd) == source.processGroup(),
        "local": ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"].allSatisfy { env[$0] == nil }, "chain": chain]
}
if CommandLine.arguments.dropFirst() == ["--owner-terminal"] {
    let accepted = ownerTerminalAccepted(ownerTerminalMetadata())
    print(accepted ? "OWNER_TERMINAL_CONFIRMED" : "LOCAL_OWNER_TTY_REQUIRED")
    exit(accepted ? 0 : 1)
}
if CommandLine.arguments.dropFirst() == ["--replay-owner-terminal"] {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        print(ownerTerminalAccepted(row) ? "OWNER_TERMINAL_CONFIRMED" : "LOCAL_OWNER_TTY_REQUIRED")
    }
    exit(0)
}

// Continuous metadata guard. Cleanup quits only bound fixture processes and
// answers only their attached Don't Save sheets. No input posts or activation.
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var v: CFTypeRef?; return AXUIElementCopyAttributeValue(e, key as CFString, &v) == .success ? v : nil
}
// Retry only unavailable reads. A readable false or changed value returns at once.
func boundedHostRead<T>(_ read: () -> T?, missing: () -> Void, pause: () -> Void = { usleep(20_000) }) -> T? {
    for attempt in 0..<3 {
        if let value = read() { return value }
        missing()
        if attempt < 2 { pause() }
    }
    return nil
}
// Kernel birth in integer microseconds. LaunchServices dates are not process identity.
func kernelInfo(_ pid: pid_t) -> (start: UInt64, ppid: pid_t)? {
    var info = proc_bsdinfo(); let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_start_tvsec > 0, info.pbi_start_tvusec < 1_000_000,
          info.pbi_start_tvsec <= (UInt64.max - info.pbi_start_tvusec) / 1_000_000 else { return nil }
    return (info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec, pid_t(info.pbi_ppid))
}
// Three reads, with at most two 20 ms pauses. A valid changed birth is never retried.
func processStart(_ pid: pid_t, read: (pid_t) -> UInt64? = { kernelInfo($0)?.start },
                  pause: () -> Void = { usleep(20_000) }) -> UInt64? {
    for attempt in 0..<3 {
        if let birth = read(pid), birth > 0 { return birth }
        if attempt < 2 { pause() }
    }
    return nil
}
func rect(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, "AXPosition"), let s = attr(e, "AXSize"), CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func emit(_ r: [String: Any]) { if let d = try? JSONSerialization.data(withJSONObject: r, options: [.sortedKeys]) { FileHandle.standardOutput.write(d); FileHandle.standardOutput.write(Data([10])) } }
func windows() -> [[String: Any]]? { CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] }
func num(_ w: [String: Any], _ k: CFString) -> Int { (w[k as String] as? NSNumber)?.intValue ?? -1 }
func bounds(_ w: [String: Any]) -> CGRect? { (w[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) } }
// System overlay metadata. The kernel path, never a display name, grants this exemption.
let notificationExecutable = "/System/Library/CoreServices/NotificationCenter.app/Contents/MacOS/NotificationCenter"
func systemOverlayExempt(executable: String?, layer: Int) -> Bool {
    layer == 21 && executable == notificationExecutable
}
struct SystemOverlayTracker {
    var active: [Int: (pid: Int32, layer: Int, began: Double)] = [:]
    mutating func sample(_ windows: [Int: (pid: Int32, layer: Int)], now: Double, utcMs: Double) -> [[String: Any]] {
        var records: [[String: Any]] = []
        for id in active.keys.sorted() {
            let previous = active[id]!
            if windows[id]?.pid != previous.pid || windows[id]?.layer != previous.layer {
                records.append(["record": "system-overlay", "state": "cleared", "pid": previous.pid,
                    "window": id, "layer": previous.layer, "timeUtcMs": utcMs, "onscreenMs": max(0, (now - previous.began) * 1000)])
                active.removeValue(forKey: id)
            }
        }
        for id in windows.keys.sorted() where active[id] == nil {
            let window = windows[id]!
            active[id] = (window.pid, window.layer, now)
            records.append(["record": "system-overlay", "state": "appeared", "pid": window.pid,
                "window": id, "layer": window.layer, "timeUtcMs": utcMs, "onscreenMs": 0])
        }
        return records
    }
}
// End system overlay metadata.
// A missing AX window list may outlive a notification. Defer across samples,
// keeping input paused and every other guard check running. Never accept nil.
struct OverlayAXRetry {
    var began: Double?, cleared: Double?
    mutating func missing(now: Double, overlay: Bool) -> String? {
        if began == nil {
            if !overlay { return "HOST_STATE_UNAVAILABLE" }
            began = now
        }
        if now - began! >= 30 { return "HOST_STATE_UNAVAILABLE" }
        if overlay { cleared = nil }
        else {
            if cleared == nil { cleared = now }
            if now - cleared! >= 1 { return "HOST_STATE_UNAVAILABLE" }
        }
        return nil
    }
}
func overlayOptIn(kind: String, requested: Any?) -> Bool {
    kind != "renderer" && (requested as? Bool) == true
}
func kernelExecutable(_ pid: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard count > 0 else { return nil }
    return String(cString: buffer)
}
func tree(_ e: AXUIElement, limit: Int = 2000) -> [AXUIElement]? {
    var q = [e], out: [AXUIElement] = []; let end = ProcessInfo.processInfo.systemUptime + 0.25
    while let n = q.popLast() {
        if out.count >= limit || ProcessInfo.processInfo.systemUptime > end { return nil }
        out.append(n); q += attr(n, "AXChildren") as? [AXUIElement] ?? []
    }
    return out
}
// Metadata only. The same bounded walk runs against synthetic nodes in --selftest.
func parentMeasurement<Node: Equatable>(_ start: Node?, pid: Int32, window: Node?,
    process: (Node) -> Int32?, role: (Node) -> String?, parent: (Node) -> Node?,
    expired: () -> Bool = { false }, menuOnly: Bool = false) -> [String: Any] {
    var node = start, seen: [Node] = [], roles: [String] = [], reason = "PARENT_LIMIT"
    for _ in 0..<66 {
        if expired() { reason = "AX_TIMEOUT"; break }
        guard let current = node else { reason = seen.isEmpty ? "HIT_UNAVAILABLE" : "PARENT_UNAVAILABLE"; break }
        guard !seen.contains(current) else { reason = "PARENT_CYCLE"; break }
        guard process(current) == pid else { reason = "FOREIGN_PID"; break }
        seen.append(current)
        guard let value = role(current), !value.isEmpty else { reason = "ROLE_UNAVAILABLE"; break }
        roles.append(value)
        if expired() { reason = "AX_TIMEOUT"; break }
        if (menuOnly && value == "AXMenu") || value == "AXApplication" || (value == "AXWindow" && current == window) {
            return ["refused": false, "nodes": seen.count, "roles": roles, "terminal": value]
        }
        node = parent(current)
    }
    return ["refused": true, "nodes": seen.count, "roles": roles, "reason": reason]
}
struct ParentAXNode: Equatable {
    let element: AXUIElement
    static func == (a: ParentAXNode, b: ParentAXNode) -> Bool { CFEqual(a.element, b.element) }
}
func measureAXParents(_ hit: AXUIElement?, pid: pid_t, window: AXUIElement?, menuOnly: Bool = false) -> [String: Any] {
    let deadline = ProcessInfo.processInfo.systemUptime + 0.12
    return parentMeasurement(hit.map { ParentAXNode(element: $0) }, pid: pid, window: window.map { ParentAXNode(element: $0) }, process: { node in
        var owner: pid_t = 0; return AXUIElementGetPid(node.element, &owner) == .success ? owner : nil
    }, role: { attr($0.element, "AXRole") as? String }, parent: { node in
        guard let p = attr(node.element, "AXParent"), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
        return ParentAXNode(element: p as! AXUIElement)
    }, expired: { ProcessInfo.processInfo.systemUptime > deadline }, menuOnly: menuOnly)
}
struct GuardSignals {
    var held = false, gapMs = 20.0, frontChanged = false, pointerChanged = false
    var personActive = false, permission = false, foreign = false, blocked = false
    var reason: String? {
        if held { return "TIMED_WINDOW_HOLD" }
        if gapMs > 500 { return "GUARD_STALE" }
        if permission { return "PERMISSION_PROMPT" }
        if frontChanged { return "FRONTMOST_CHANGED" }
        if pointerChanged { return "POINTER_CHANGED" }
        if personActive { return "PERSON_ACTIVE" }
        if foreign { return "FOREIGN_WINDOW" }
        if blocked { return "WINDOW_BLOCKED" }
        return nil
    }
}
// UC3F is separate from RT31's ten-minute, background-only VM guard.
struct UC3FGuardPolicy {
    let presence: String, blockSeconds: Double
    var valid: Bool { blockSeconds == (presence == "away" ? 9000 : presence == "present" ? 3600 : -1) }
    func arm(ownerConfirmed: Bool, initialIdle: Double, lockValid: Bool) -> String? {
        if !valid { return "BLOCK_CAP_REQUIRED" }
        if !lockValid { return "LIVE_LOCK_CHANGED" }
        if presence == "present" && !ownerConfirmed { return "OWNER_GO_REQUIRED" }
        if !initialIdle.isFinite || initialIdle < (presence == "present" ? 0 : 2) { return "PERSON_ACTIVE" }
        return nil
    }
    func reason(_ input: GuardSignals, elapsed: Double, lockValid: Bool) -> String? {
        var signals = input
        if presence == "present" {
            signals.frontChanged = false; signals.pointerChanged = false; signals.personActive = false
        }
        if let reason = signals.reason { return reason }
        if !valid || !elapsed.isFinite || elapsed >= blockSeconds { return "DEADLINE_EXCEEDED" }
        if !lockValid { return "LIVE_LOCK_CHANGED" }
        return nil
    }
}
// Pure safety decisions shared by host sampling and --replay-fixtures.
let contextMenuAllowanceSeconds = 3.0
func fixtureSamplingAllowed(bundle: String, pid: Int32, permitted: Bool, owned: Bool, bound: Bool, chromePID: Int32?) -> Bool {
    if bundle == "com.google.Chrome" {
        // A pending launch can have windows, but only readiness may adopt its PID.
        return chromePID == nil ? permitted : chromePID == pid && owned && bound
    }
    return permitted || (owned && bound)
}
struct FixtureWindow {
    var pid: Int32, layer: Int, bundle: String
    var baseline = false, owned = false, fixture = false, cleaning = false, menu = false, titleAllowed = true
}
func menuParentAccepted(_ measured: [String: Any]) -> Bool {
    measured["terminal"] as? String == "AXMenu" && measured["refused"] as? Bool == false
}
func fixtureWindowSignals(_ rows: [FixtureWindow], now: Double, menuUntil: Double) -> GuardSignals {
    var signals = GuardSignals()
    func menuAllowed(_ row: FixtureWindow) -> Bool {
        row.fixture && row.bundle == "org.sleight.bench.rt25-witness" && row.layer > 0 && row.menu && now < menuUntil
    }
    for row in rows where row.layer >= 0 {
        if ["com.apple.SecurityAgent", "com.apple.UserNotificationCenter", "com.apple.CoreServicesUIAgent", "com.apple.ScreenTimeAgent"].contains(row.bundle) { signals.permission = true }
        if !row.baseline && !row.owned && !row.fixture { signals.foreign = true }
        if row.fixture && !row.cleaning {
            let ownedRows = rows.filter { $0.pid == row.pid }
            let extras = ownedRows.filter { $0.layer != 0 }
            let allowance = extras.count == 1 && extras.allSatisfy(menuAllowed) ? 1 : 0
            if ownedRows.count > (row.bundle == "com.apple.TextEdit" ? 2 : 1) + allowance ||
                (row.layer != 0 && !menuAllowed(row)) { signals.blocked = true }
            if !row.titleAllowed { signals.foreign = true }
        }
    }
    return signals
}
struct FixtureProcess {
    var pid: Int32, owned: Bool, bound: Bool
}
func chromeProcessesAllowed(_ running: [FixtureProcess], permitted: Bool, chromePID: Int32?) -> Bool {
    if running.isEmpty { return true }
    guard running.count == 1 else { return false }
    if let pid = chromePID { return running[0].pid == pid && running[0].owned && running[0].bound }
    return permitted
}
func optionalChrome(installed: Bool, running: [FixtureProcess]) -> [String: Any] {
    return ["available": installed && running.isEmpty,
        "reason": !running.isEmpty ? "APP_ALREADY_RUNNING" : installed ? "READY" : "APP_NOT_INSTALLED"]
}
func fixtureLaunchAllowed(bundle: String, running: [FixtureProcess]) -> Bool {
    if bundle == "com.google.Chrome" && !running.isEmpty { return false }
    return running.allSatisfy { $0.owned && $0.bound }
}
func chromeFixtureReady(permitted: Bool, running: [FixtureProcess], roles: [String]?) -> Bool {
    permitted && running.count == 1 && running[0].owned && running[0].bound && roles == ["AXWindow"]
}
func contextMenuAllowed(bundle: String, bound: Bool, background: Bool, roles: [String], validFrame: Bool) -> Bool {
    bundle == "org.sleight.bench.rt25-witness" && bound && background && validFrame && roles.filter { $0 == "AXWindow" }.count == 1
}
func chromeCleanupAllowed(owned: Bool, bound: Bool) -> Bool { owned && bound }
func windowEvidence(pid: Int32, bundle: String, id: Int, owner: String, name: String, layer: Int,
    frame: CGRect?, alpha: Double?) -> [String: Any] {
    var evidence: [String: Any] = ["pid": pid, "bundle": bundle, "window": id, "owner": owner, "name": name, "layer": layer,
        "bounds": frame.map { [$0.minX, $0.minY, $0.width, $0.height] } as Any? ?? NSNull(),
        "alpha": alpha as Any? ?? NSNull()]
    if ["StatusIndicator", "Software Cursor"].contains(name) {
        evidence["privacyIndicator"] = name == "StatusIndicator" ? "unidentified" : "not-applicable"
    }
    return evidence
}
// Titles can hold personal content. Only the two fixed system labels survive
// publication. Personal titles never form part of a retained identity.
func publishedWindowEvidence(_ evidence: [String: Any]) -> [String: Any] {
    let name = evidence["name"] as? String ?? ""
    return ["owner": evidence["owner"] as? String ?? "", "name": ["StatusIndicator", "Software Cursor"].contains(name) ? name : "",
        "layer": evidence["layer"] as? Int ?? 0]
}
struct ForeignWindowObservations {
    static let capacity = 256
    var overflow = 0
    var counts: [String: Int] = [:], evidence: [String: [String: Any]] = [:]
    mutating func record(_ row: [String: Any]) -> [String: Any]? {
        var identity = row.filter { ["pid", "bundle", "window", "owner", "name", "layer"].contains($0.key) }
        identity["name"] = publishedWindowEvidence(row)["name"]
        guard let data = try? JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]),
              let key = String(data: data, encoding: .utf8) else { return nil }
        if counts[key] == nil && counts.count >= Self.capacity {
            overflow += 1
            return overflow == 1 ? ["overflow": true] : nil
        }
        counts[key, default: 0] += 1
        if evidence[key] != nil { return nil }
        let published = publishedWindowEvidence(row)
        evidence[key] = published
        return published
    }
    var summary: [[String: Any]] {
        var rows: [[String: Any]] = counts.keys.sorted().map { key in
            evidence[key]!.merging(["count": counts[key]!]) { _, new in new }
        }
        if overflow > 0 { rows.append(["overflow": true, "count": overflow]) }
        return rows
    }
}
// Counts describe observations. They cannot distinguish a person's first
// event during a call from the Glide engine's posted event.
func runtimeHandsOffAdmission(kind: String, requested: Bool, observeOnly: Bool, confirmed: Bool) -> Bool {
    !requested || (kind == "runtime" && !observeOnly && confirmed)
}
func runtimeResetAllowance(observeOnly: Bool, measured: Int?) -> Int? {
    if observeOnly { return measured ?? 32 }
    return measured == 0 ? 0 : nil
}
struct CoverWindow {
    let pid: Int32, frame: CGRect?
}
struct CoverSample {
    let frame: CGRect?, visible: [CoverWindow]?
}
func coverConfirmed(_ sample: CoverSample, target: CGRect, pointer: CGPoint, coverPID: Int32, witnessPID: Int32) -> Bool {
    guard let frame = sample.frame, frame.contains(pointer), frame.contains(target), let visible = sample.visible,
          let coverAt = visible.firstIndex(where: { $0.pid == coverPID && ($0.frame?.intersects(target) ?? false) }),
          let witnessAt = visible.firstIndex(where: { $0.pid == witnessPID }), coverAt < witnessAt,
          let serverFrame = visible[coverAt].frame, serverFrame.contains(target), serverFrame.contains(pointer) else { return false }
    return true
}
func waitForCover(target: CGRect, pointer: CGPoint, coverPID: Int32, witnessPID: Int32,
    sample: () -> CoverSample, now: () -> Double, pause: (Double) -> Void) -> Bool {
    let deadline = now() + 0.300
    for _ in 0..<7 {
        let current = sample()
        if now() > deadline { return false }
        if coverConfirmed(current, target: target, pointer: pointer, coverPID: coverPID, witnessPID: witnessPID) { return true }
        let remaining = deadline - now()
        if remaining <= 0 { return false }
        pause(min(0.050, remaining))
    }
    return false
}
// End pure fixture safety decisions.
// The same detector runs on host samples and on offline JSON idle recordings.
// A 5 ms tolerance covers clock/read jitter, not an extra HID event allowance.
struct IdleDetector {
    var anchorTime: Double, anchorIdle: Double
    var window = 0, label = "", resets = 0, totalResets = 0
    var closesAt: Double?, active = false, nextWindow = 0, allowance = 1
    var openedAt: Double?, ownerObserved = false
    mutating func expire(_ now: Double) { if let end = closesAt, now > end { active = false; closesAt = nil } }
    mutating func open(_ now: Double, label: String, allowance: Int = 1) -> Bool {
        expire(now)
        guard !active, (0...32).contains(allowance) else { return false }
        self.allowance = allowance
        openedAt = now
        nextWindow += 1; window = nextWindow; self.label = label; resets = 0; active = true
        return true
    }
    mutating func close(_ now: Double) -> Bool {
        guard active, closesAt == nil else { return false }
        closesAt = now + 0.150; return true
    }
    mutating func sample(_ now: Double, idle: Double) -> (Bool, [String: Any]?) {
        expire(now)
        guard now.isFinite, idle.isFinite, idle >= 0, now >= anchorTime else { return (true, nil) }
        let expected = anchorIdle + now - anchorTime
        guard idle + 0.005 < expected else { return (false, nil) }
        totalResets += 1
        if active { resets += 1 }
        let accepted = !ownerObserved && active && resets <= allowance
        let record: [String: Any] = ["record": "hid-reset", "window": active ? window as Any : NSNull(),
            "label": active ? label : "outside", "resetInWindow": active ? resets : 0,
            "ownerObserved": ownerObserved, "inferredInputUptime": now - idle,
            "sampleInPostedActionWindow": active, "offsetFromStartMs": openedAt.map { (now - idle - $0) * 1000 } as Any? ?? NSNull(),
            "accepted": accepted, "idleMs": idle * 1000, "expectedIdleMs": expected * 1000, "uptime": now]
        // Rebase even a rejected observation so observe-only logs each new
        // reset once instead of logging every subsequent sample as that reset.
        anchorTime = now; anchorIdle = idle
        return (!accepted && !ownerObserved, record)
    }
}
// AX work may have variable latency. Pair the idle value with a timestamp
// obtained immediately after its read, rather than the timer's start time.
func sampleIdle(_ detector: inout IdleDetector, afterAX: () -> Void, readIdle: () -> Double, clock: () -> Double) -> (Bool, [String: Any]?) {
    afterAX()
    let idle = readIdle(), timestamp = clock()
    return detector.sample(timestamp, idle: idle)
}
// Renderer sittings use the away-script threshold throughout fixture lifetime.
// HID resets latch a stop, even if the next observation is idle again.
struct RendererSittingState {
    var detector: IdleDetector?, last: Double?, stop: String?
    mutating func sample(now: Double, idle: Double, held: Bool) -> String? {
        if stop != nil { return stop }
        if held { stop = "TIMED_WINDOW_HOLD" }
        else if !now.isFinite || !idle.isFinite || idle < 30 { stop = "PERSON_ACTIVE" }
        else if let previous = last, now < previous || now - previous > 0.5 { stop = "GUARD_STALE" }
        else if var current = detector {
            if current.sample(now, idle: idle).0 { stop = "PERSON_ACTIVE" }
            detector = current
        } else { detector = IdleDetector(anchorTime: now, anchorIdle: idle) }
        last = now
        return stop
    }
}

struct FocusDetector {
    var misses = 0
    mutating func changed(_ same: Bool?) -> Bool {
        guard let same = same else { misses += 1; return misses >= 3 }
        misses = 0; return !same
    }
}
func fixtureTitle(_ title: String) -> Bool { title.contains("SIT1-") || title.contains("RT13-") }
func ownedDocument(title: String, path: String?, expected: Set<String>) -> Bool {
    path.map { expected.contains($0) } == true
}
func retainedDocument(same: Bool, path: String?, target: String, expected: Set<String>) -> Bool {
    same && expected.contains(target) && (path == nil || path == target)
}
func mayQuitDocument(edited: Bool?, attached: Bool) -> Bool {
    // Normal quit can activate a dirty app to display a sheet. Only an explicit
    // clean read authorizes normal quit. Other states need fixture-only discard.
    !attached && edited == false
}
func editedState(_ values: [Bool?]) -> Bool? {
    if values.contains(where: { $0 == true }) { return true }
    return values.contains(where: { $0 == false }) ? false : nil
}
// The brief permits discarding fixture changes through NSRunningApplication.
// Keep the dispatch decision injectable so its refusal paths run without apps.
func requestFixtureQuit(bundle: String, bound: Bool, fixtureOnly: Bool, edited: [Bool?], writeIntent: Bool = false, normal: () -> Bool, discard: () -> Bool) -> Bool {
    guard bound else { return false }
    if bundle == "com.apple.TextEdit" {
        guard fixtureOnly else { return false }
        return !writeIntent && edited.allSatisfy({ mayQuitDocument(edited: $0, attached: false) }) ? normal() : discard()
    }
    guard ["com.apple.calculator", "org.sleight.bench.rt25-witness", "com.google.Chrome"].contains(bundle) else { return false }
    return normal()
}
func fixtureCandidate(title: String, path: String?, target: String, fresh: Bool) -> Bool {
    let url = URL(fileURLWithPath: target)
    return fresh && fixtureTitle(title) && [url.lastPathComponent, url.deletingPathExtension().lastPathComponent].contains(title) && (path == nil || path == target)
}
// realpath(3) keeps /private/tmp. Foundation's resolvingSymlinksInPath strips a leading /private, so a bank under
// /private/tmp never equalled its own resolved path (live owner-away observation, 2026-11-01).
func canonicalPath(_ path: String) -> String? {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard realpath(path, &buf) != nil else { return nil }
    return String(cString: buf)
}
func documentPathValue(_ value: String?) -> String? {
    guard let value = value else { return nil }
    let path: String
    if value.hasPrefix("/"), !value.hasPrefix("//") { path = value }
    else if let url = URL(string: value), url.isFileURL, url.path.hasPrefix("/"),
            url.host == nil || url.host == "" || url.host == "localhost" { path = url.standardizedFileURL.path }
    else { return nil }
    // macOS 27 can return an unresolved file-reference URL instead of a path.
    guard path.hasPrefix("/"), !path.hasPrefix("/.file/") else { return nil }
    // A vanished document keeps its path so exact-match checks still refuse it.
    return canonicalPath(path) ?? path
}
func documentPath(_ window: AXUIElement) -> String? {
    documentPathValue(attr(window, "AXDocument") as? String)
}
final class PendingDocument {
    let target: String, before: Set<Int>
    var pid: Int32?, start: UInt64?, window: AXUIElement?, cgWindow: Int?
    init(target: String, before: Set<Int>) { self.target = target; self.before = before }
}
struct DocumentBindingResult {
    let code: String
    var candidateCount: Int? = nil
    var ok: Bool { code == "BOUND" }
    func reply(pending: Bool) -> [String: Any] {
        var row: [String: Any] = ["reply": "bind-document", "bindCode": code, "pendingDocument": pending]
        if ok { row["ok"] = true } else { row["error"] = "FIXTURE_BINDING_REQUIRED" }
        if let count = candidateCount { row["candidateCount"] = count }
        return row
    }
}
func discardAllowed(cleaning: Bool, bound: Bool, attached: Bool, titles: [String]) -> Bool {
    let discard = ["Don't Save", "Don’t Save"]
    let allowed = discard + ["Save", "Save…", "Save...", "Save As…", "Save As...", "Cancel", ""]
    return cleaning && bound && attached && titles.filter { discard.contains($0) }.count == 1 && titles.allSatisfy { allowed.contains($0) }
}
func uncovered(_ rows: [[String: Any]], pid: Int32, window: Int) -> Bool {
    let owned = rows.filter { num($0, kCGWindowOwnerPID) == Int(pid) }
    guard owned.count == 1, num(owned[0], kCGWindowNumber) == window,
          let target = bounds(owned[0]), target.width > 0, target.height > 0,
          let at = rows.firstIndex(where: { num($0, kCGWindowNumber) == window }) else { return false }
    return !rows.prefix(at).contains { w in
        num(w, kCGWindowOwnerPID) != Int(pid) && (w[kCGWindowAlpha as String] as? Double ?? 1) > 0 && (bounds(w)?.intersects(target) ?? true)
    }
}
final class Guard {
    var systemOverlays = SystemOverlayTracker()
    func overlayWindows(_ rows: [[String: Any]], readExecutable: (Int32) -> String? = kernelExecutable) -> Set<Int> {
        var ids = Set<Int>()
        for row in rows {
            let layer = num(row, kCGWindowLayer)
            if layer == 21 && systemOverlayExempt(executable: readExecutable(Int32(num(row, kCGWindowOwnerPID))), layer: layer) {
                ids.insert(num(row, kCGWindowNumber))
            }
        }
        return ids
    }
    func recordOverlayEnd() {
        let now = ProcessInfo.processInfo.systemUptime
        for id in systemOverlays.active.keys.sorted() {
            let overlay = systemOverlays.active[id]!
            emit(["record": "system-overlay", "state": "observed-at-close", "pid": overlay.pid,
                "window": id, "layer": overlay.layer, "timeUtcMs": Date().timeIntervalSince1970 * 1000,
                "onscreenMs": max(0, (now - overlay.began) * 1000)])
        }
    }
    // The sample loop and --dump-overlay share this. A missing opt-in leaves the banner foreign.
    func overlayExemption(_ rows: [[String: Any]], readExecutable: (Int32) -> String? = kernelExecutable) -> Set<Int> {
        guard exemptSystemOverlay, kind != "renderer" else { return Set<Int>() }
        return overlayWindows(rows, readExecutable: readExecutable)
    }
    var armed = false, kind = "", stop: String?, baseline = Set<Int>(), own = Set<Int32>()
    // Off unless this arm's caller pauses input while a banner is onscreen.
    var exemptSystemOverlay = false
    var front: Int32 = 0, focused: CGRect?, pointer = CGPoint.zero, began = 0.0
    var focusedElement: AXUIElement?, ownStarts: [Int32: UInt64] = [:]
    var idleDetector = IdleDetector(anchorTime: 0, anchorIdle: 0), focusDetector = FocusDetector(), observeOnly = false, ownerPresentHandsOff = false
    var cleaning = Set<Int32>(), cleanupWindows: [Int32: [AXUIElement]] = [:], cleanupDeadline = 0.0, cleanupError: String?
    var discardedSheets: [AXUIElement] = [], quitRequested = Set<Int32>()
    var recordActionWindows = false
    var foreignSeen = ForeignWindowObservations()
    var foreignWindows: [[String: Any]] = [], overlayWindows: [[String: Any]] = []
    var expectedDocuments = Set<String>()
    var pendingDocument: PendingDocument?
    var fixtureBindings: [Int32: [(window: AXUIElement, target: String)]] = [:]
    var writeIntents = Set<Int32>(), launchPermits = Set<String>()
    var rendererState = RendererSittingState()
    var chromePID: Int32?
    var samples = 0, last = 0.0, maxGap = 0.0
    let parent = getppid(), started = UInt64(Date().timeIntervalSince1970 * 1_000_000)
    var uc3fPolicy: UC3FGuardPolicy?, lockDevice: dev_t?, lockInode: ino_t?
    var ownerPresent: Bool { uc3fPolicy?.presence == "present" }
    // Host reads stay at the call sites. Dump mode exercises this same arm and
    // sample wiring with metadata fixtures and never reads the desktop or lock.
    func armUC3F(_ r: [String: Any], initialIdle: Double, lockValid: Bool) -> String? {
        let policy = UC3FGuardPolicy(presence: kind == "uc3f-away" ? "away" : "present", blockSeconds: r["blockSeconds"] as? Double ?? -1)
        if let error = policy.arm(ownerConfirmed: r["ownerConfirmed"] as? Bool == true, initialIdle: initialIdle, lockValid: lockValid) { return error }
        uc3fPolicy = policy
        return nil
    }
    func checkDeadline(_ now: Double) {
        if uc3fPolicy == nil && now - began > (kind == "vm" ? 600 : observeOnly ? 300 : 2100) { fault("DEADLINE_EXCEEDED", read: "ELAPSED_SECONDS", value: String(now - began)) }
    }
    func recordForeign(_ evidence: [String: Any]) {
        guard let published = foreignSeen.record(evidence) else { return }
        emit(published.merging(["record": "foreign-window-seen", "uptime": ProcessInfo.processInfo.systemUptime]) { _, new in new })
    }

    func sampleSignals(_ signals: GuardSignals, now: Double, lockValid: () -> Bool) {
        if let policy = uc3fPolicy {
            if let reason = policy.reason(signals, elapsed: now - began, lockValid: lockValid()) { signalFault(reason, signals, now) }
        } else {
            if let reason = signals.reason { signalFault(reason, signals, now) }
            if ownerPresentHandsOff && !lockValid() { fault("LIVE_LOCK_CHANGED") }
        }
    }
    func liveLockValid(bind: Bool = false) -> Bool {
        var st = stat()
        guard Darwin.lstat("/tmp/sleight-live.lock", &st) == 0, (st.st_mode & S_IFMT) == S_IFDIR,
              st.st_uid == getuid() else { return false }
        if bind { lockDevice = st.st_dev; lockInode = st.st_ino }
        return st.st_dev == lockDevice && st.st_ino == lockInode
    }
    var stopRead: [String: Any]?
    func fault(_ s: String, read: String = "GUARD_CONDITION", value: String? = nil, pid: Int32 = 0) {
        if stop == nil {
            stop = s
            stopRead = ["read": read, "value": value ?? s, "pid": pid]
            if armed { emit(["record": "guard-stop", "stop": s, "failedRead": stopRead!]) }
        }
    }
    func hostRead<T>(_ name: String, pid: Int32 = 0, required: () -> Bool = { true }, _ read: () -> T?) -> T? {
        var missing = 0
        let value = boundedHostRead(read, missing: { missing += 1 })
        if missing > 0 && armed { emit(["record": "guard-read-retry", "read": name, "value": "nil", "nilReads": missing, "recovered": value != nil, "pid": pid]) }
        if value == nil && required() {
            fault("HOST_STATE_UNAVAILABLE", read: name, value: "nil", pid: pid)
        }
        return value
    }
    func frontWindow(_ pid: Int32) -> CGRect? {
        let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.05)
        guard let w = attr(app, "AXFocusedWindow"), CFGetTypeID(w) == AXUIElementGetTypeID() else { return nil }
        return rect(w as! AXUIElement)
    }
    func sameFocusedWindow(_ pid: Int32) -> Bool? {
        let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.03)
        guard let w = attr(app, "AXFocusedWindow"), CFGetTypeID(w) == AXUIElementGetTypeID(), let original = focusedElement,
              let frame = rect(w as! AXUIElement) else { return nil }
        return CFEqual(original, w) && frame == focused
    }
    var pendingAXWindows: [Int32: OverlayAXRetry] = [:]
    func windowRead(_ pid: Int32, overlay: Bool, now: Double, required: () -> Bool,
                    read: () -> [AXUIElement]?) -> [AXUIElement]? {
        var missing = 0
        let value = boundedHostRead(read, missing: { missing += 1 })
        if value != nil { pendingAXWindows.removeValue(forKey: pid) }
        else if required() {
            var retry = pendingAXWindows[pid] ?? OverlayAXRetry()
            if let reason = retry.missing(now: now, overlay: overlay) {
                fault(reason, read: "AX_WINDOWS", value: "nil", pid: pid)
            } else { pendingAXWindows[pid] = retry }
        } else { pendingAXWindows.removeValue(forKey: pid) }
        if missing > 0 && armed {
            emit(["record": "guard-read-retry", "read": "AX_WINDOWS", "value": "nil", "nilReads": missing,
                "recovered": value != nil, "pending": pendingAXWindows[pid] != nil, "pid": pid])
        }
        return value
    }
    func signalFault(_ reason: String, _ signals: GuardSignals, _ now: Double) {
        let reads: [String: (String, String)] = [
            "TIMED_WINDOW_HOLD": ("HOLD_PRESENT", String(signals.held)),
            "GUARD_STALE": ("SAMPLE_GAP_MS", String(signals.gapMs)),
            "PERMISSION_PROMPT": ("PERMISSION_WINDOW_PRESENT", String(signals.permission)),
            "FRONTMOST_CHANGED": ("FRONT_WINDOW_MATCH", String(!signals.frontChanged)),
            "POINTER_CHANGED": ("POINTER_MATCH", String(!signals.pointerChanged)),
            "PERSON_ACTIVE": ("HID_ACTIVITY", String(signals.personActive)),
            "FOREIGN_WINDOW": ("FOREIGN_WINDOW_PRESENT", String(signals.foreign)),
            "WINDOW_BLOCKED": ("BLOCKED_WINDOW_PRESENT", String(signals.blocked)),
            "DEADLINE_EXCEEDED": ("ELAPSED_SECONDS", String(now - began)),
            "LIVE_LOCK_CHANGED": ("LIVE_LOCK_MATCH", "false"),
        ]
        let read = reads[reason] ?? ("GUARD_CONDITION", reason)
        fault(reason, read: read.0, value: read.1)
    }
    func identity(_ app: NSRunningApplication?) -> UInt64? {
        guard let app = app else { return nil }
        guard let birth = processStart(app.processIdentifier) else { fault("PROCESS_START_UNREADABLE", read: "KERNEL_PROCESS_BIRTH", value: "nil", pid: app.processIdentifier); return nil }
        return birth
    }
    func bound(_ pid: Int32) -> Bool {
        guard let app = NSRunningApplication(processIdentifier: pid), let start = ownStarts[pid] else { return false }
        return identity(app) == start && ["com.apple.TextEdit", "com.apple.calculator", "org.sleight.bench.rt25-witness", "com.google.Chrome"].contains(app.bundleIdentifier ?? "")
    }
    func fixtureProcesses(_ apps: [NSRunningApplication]) -> [FixtureProcess] {
        apps.map { FixtureProcess(pid: $0.processIdentifier, owned: own.contains($0.processIdentifier), bound: bound($0.processIdentifier)) }
    }
    func discardButton(_ sheet: AXUIElement, pid: Int32, parent: AXUIElement) -> AXUIElement? {
        guard let retained = cleanupWindows[pid], retained.contains(where: { CFEqual($0, parent) }),
              let nodes = tree(sheet, limit: 128) else { return nil }
        let buttons = nodes.filter { attr($0, "AXRole") as? String == "AXButton" }
        let titles = buttons.compactMap { attr($0, "AXTitle") as? String }
        guard titles.count == buttons.count,
              discardAllowed(cleaning: cleaning.contains(pid), bound: bound(pid), attached: true, titles: titles) else { return nil }
        return buttons.first { ["Don't Save", "Don’t Save"].contains(attr($0, "AXTitle") as? String ?? "") }
    }
    func expectedCleanupSheet(_ sheet: AXUIElement, pid: Int32) -> Bool {
        return (cleanupWindows[pid] ?? []).contains { parent in
            (attr(parent, "AXSheets") as? [AXUIElement] ?? []).contains { CFEqual($0, sheet) } && discardButton(sheet, pid: pid, parent: parent) != nil
        }
    }
    func bindDocument() -> DocumentBindingResult {
        guard let pending = pendingDocument else { return DocumentBindingResult(code: "NO_PENDING_DOCUMENT") }
        guard let rows = windows() else { return DocumentBindingResult(code: "WINDOWS_UNAVAILABLE") }
        let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit")
        guard apps.count == 1 else { return DocumentBindingResult(code: "INSTANCE_COUNT") }
        guard launchPermits.contains("com.apple.TextEdit") else { return DocumentBindingResult(code: "LAUNCH_PERMIT_REQUIRED") }
        guard let date = identity(apps[0]) else { return DocumentBindingResult(code: "PROCESS_START_UNREADABLE") }
        guard date >= started else { return DocumentBindingResult(code: "PROCESS_START_INVALID") }
        let pid = apps[0].processIdentifier
        if let previous = ownStarts[pid], previous != date { return DocumentBindingResult(code: "PROCESS_START_CHANGED") }
        if let expected = pending.pid, expected != pid || pending.start != date { return DocumentBindingResult(code: "PROCESS_START_CHANGED") }
        pending.pid = pid; pending.start = date
        own.insert(pid); ownStarts[pid] = date
        let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.03)
        guard let list = attr(app, "AXWindows") as? [AXUIElement] else { return DocumentBindingResult(code: "AX_WINDOWS_UNAVAILABLE") }
        let fresh = rows.filter { num($0, kCGWindowOwnerPID) == Int(pid) && num($0, kCGWindowLayer) == 0 && !pending.before.contains(num($0, kCGWindowNumber)) }
        guard !fresh.isEmpty else { return DocumentBindingResult(code: "NO_FRESH_CG_WINDOW") }
        // An AX title can identify a settling window. A CG title cannot identify
        // a title-less AX element until their frames agree.
        let eligible = list.filter { w in
            (pending.window == nil || CFEqual(pending.window!, w)) && fresh.contains { row in
                (pending.cgWindow == nil || pending.cgWindow == num(row, kCGWindowNumber)) &&
                fixtureCandidate(title: attr(w, "AXTitle") as? String ?? row[kCGWindowName as String] as? String ?? "",
                    path: documentPath(w), target: pending.target, fresh: true)
            }
        }
        guard !eligible.isEmpty else { return DocumentBindingResult(code: "TITLE_PATH_MISMATCH") }
        if eligible.count == 1 {
            if pending.window == nil && attr(eligible[0], "AXTitle") as? String != nil { pending.window = eligible[0] }
            if pending.cgWindow == nil && fresh.count == 1 { pending.cgWindow = num(fresh[0], kCGWindowNumber) }
        }
        let candidates = eligible.filter { w in
            guard let frame = rect(w) else { return false }
            return fresh.filter { row in
                guard pending.cgWindow == nil || pending.cgWindow == num(row, kCGWindowNumber),
                      fixtureCandidate(title: attr(w, "AXTitle") as? String ?? row[kCGWindowName as String] as? String ?? "",
                        path: documentPath(w), target: pending.target, fresh: true), let other = bounds(row) else { return false }
                return abs(frame.minX - other.minX) < 0.5 && abs(frame.minY - other.minY) < 0.5 && abs(frame.width - other.width) < 0.5 && abs(frame.height - other.height) < 0.5
            }.count == 1
        }
        guard !candidates.isEmpty || eligible.count != 1 else { return DocumentBindingResult(code: "FRAME_MISMATCH") }
        guard candidates.count == 1 else { return DocumentBindingResult(code: "CANDIDATE_COUNT", candidateCount: candidates.count) }
        fixtureBindings[pid, default: []].append((candidates[0], pending.target)); pendingDocument = nil
        return DocumentBindingResult(code: "BOUND")
    }
    func cleanupTick() {
        for pid in cleaning {
            guard let process = NSRunningApplication(processIdentifier: pid), !process.isTerminated else { cleaning.remove(pid); continue }
            guard bound(pid) else { cleanupError = "CLEANUP_IDENTITY_CHANGED"; continue }
            if quitRequested.contains(pid) { continue }
            let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.03)
            guard let list = attr(app, "AXWindows") as? [AXUIElement] else { continue }
            let docs = list.filter { attr($0, "AXRole") as? String != "AXSheet" }
            let retained = cleanupWindows[pid] ?? []
            let sheets = docs.flatMap { attr($0, "AXSheets") as? [AXUIElement] ?? [] }
            guard docs.count == retained.count, docs.allSatisfy({ w in retained.contains { CFEqual($0, w) } }),
                  list.allSatisfy({ w in docs.contains { CFEqual($0, w) } || sheets.contains { CFEqual($0, w) } }) else {
                cleanupError = "CLEANUP_WINDOWS_UNCONFIRMED"; continue
            }
            let fixtureOnly = process.bundleIdentifier != "com.apple.TextEdit" || docs.allSatisfy({ w in
                (fixtureBindings[pid] ?? []).contains { retainedDocument(same: CFEqual($0.window, w), path: documentPath(w), target: $0.target, expected: expectedDocuments) }
            })
            guard fixtureOnly else { cleanupError = "CLEANUP_WINDOWS_UNCONFIRMED"; continue }
            for w in list {
                for sheet in attr(w, "AXSheets") as? [AXUIElement] ?? [] {
                    if discardedSheets.contains(where: { CFEqual($0, sheet) }) { continue }
                    guard let button = discardButton(sheet, pid: pid, parent: w) else { cleanupError = "CLEANUP_SHEET_REFUSED"; continue }
                    discardedSheets.append(sheet)
                    // Recheck the process immediately before the one allowed AX action.
                    if bound(pid), AXUIElementPerformAction(button, "AXPress" as CFString) == .success {
                        emit(["record": "cleanup-discard", "pid": pid])
                    } else { cleanupError = "CLEANUP_DISCARD_UNCONFIRMED" }
                }
            }
            if process.bundleIdentifier == "com.apple.TextEdit" {
                if docs.contains(where: { !(attr($0, "AXSheets") as? [AXUIElement] ?? []).isEmpty }) { continue }
            }
            let edited = docs.map { editedState([attr($0, "AXDocumentEdited") as? Bool, attr($0, "AXEdited") as? Bool]) }
            if process.bundleIdentifier == "com.apple.TextEdit" {
                emit(["record": "cleanup-edited-state", "pid": pid, "documents": docs.count,
                    "unavailableDocuments": edited.filter { $0 == nil }.count,
                    "note": edited.contains(where: { $0 == nil }) ? "AXDocumentEdited/AXEdited unavailable; fixture discard required." : "Edited-state attributes available.",
                    "writeIntent": writeIntents.contains(pid)])
            }
            guard requestFixtureQuit(bundle: process.bundleIdentifier ?? "", bound: bound(pid), fixtureOnly: fixtureOnly, edited: edited,
                writeIntent: writeIntents.contains(pid),
                normal: { process.terminate() }, discard: {
                    let sent = process.forceTerminate()
                    if sent { emit(["record": "cleanup-fixture-discard", "pid": pid, "documents": docs.count, "writeIntent": writeIntents.contains(pid)]) }
                    return sent
                }) else { cleanupError = "CLEANUP_QUIT_REFUSED"; continue }
            writeIntents.remove(pid)
            if let bundle = process.bundleIdentifier { launchPermits.remove(bundle) }
            quitRequested.insert(pid)
        }
        if !cleaning.isEmpty && ProcessInfo.processInfo.systemUptime > cleanupDeadline { cleanupError = "CLEANUP_DEADLINE" }
    }
    func beginCleanup(_ bundles: [String]) -> [String: Any] {
        guard kind == "runtime", !bundles.isEmpty, Set(bundles).count == bundles.count,
              bundles.allSatisfy({ ["com.apple.TextEdit", "com.apple.calculator", "org.sleight.bench.rt25-witness", "com.google.Chrome"].contains($0) }), cleaning.isEmpty else {
            return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_REQUIRED"]
        }
        if pendingDocument != nil { _ = bindDocument() }
        // Only a launch explicitly announced by this harness may be adopted.
        for app in NSWorkspace.shared.runningApplications where bundles.contains(app.bundleIdentifier ?? "") {
            if app.bundleIdentifier == "com.google.Chrome" {
                // A permit names a bundle, not a process. Never adopt an unbound Chrome during cleanup.
                guard chromeCleanupAllowed(owned: own.contains(app.processIdentifier), bound: bound(app.processIdentifier)) else { return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_REQUIRED"] }
            } else {
                guard own.contains(app.processIdentifier) || launchPermits.contains(app.bundleIdentifier ?? "") else { return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_REQUIRED"] }
            }
            guard let date = identity(app), date >= started else { return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_REQUIRED"] }
            if let previous = ownStarts[app.processIdentifier], previous != date { return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_CHANGED"] }
            own.insert(app.processIdentifier); ownStarts[app.processIdentifier] = date
        }
        let targets = own.filter { bundles.contains(NSRunningApplication(processIdentifier: $0)?.bundleIdentifier ?? "") }
        var retained: [Int32: [AXUIElement]] = [:]
        for pid in targets {
            guard bound(pid), let app = NSRunningApplication(processIdentifier: pid) else { return ["reply": "quit-fixtures", "error": "CLEANUP_IDENTITY_CHANGED"] }
            let ax = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(ax, 0.03)
            guard let list = attr(ax, "AXWindows") as? [AXUIElement] else { return ["reply": "quit-fixtures", "error": "CLEANUP_WINDOWS_UNCONFIRMED"] }
            let docs = list.filter { attr($0, "AXRole") as? String != "AXSheet" }
            let attached = docs.flatMap { attr($0, "AXSheets") as? [AXUIElement] ?? [] }
            guard docs.count <= (app.bundleIdentifier == "com.apple.TextEdit" ? 2 : 1),
                  list.allSatisfy({ w in docs.contains { CFEqual($0, w) } || attached.contains { CFEqual($0, w) } }) else { return ["reply": "quit-fixtures", "error": "CLEANUP_WINDOWS_UNCONFIRMED"] }
            if app.bundleIdentifier == "com.apple.TextEdit" && !docs.allSatisfy({ w in
                let path = documentPath(w)
                return (fixtureBindings[pid] ?? []).contains { retainedDocument(same: CFEqual($0.window, w), path: path, target: $0.target, expected: expectedDocuments) }
            }) {
                return ["reply": "quit-fixtures", "error": "CLEANUP_WINDOWS_UNCONFIRMED"]
            }
            retained[pid] = docs
        }
        cleanupWindows = retained; cleaning = targets; cleanupError = nil; discardedSheets = []; quitRequested = []
        cleanupDeadline = ProcessInfo.processInfo.systemUptime + 10
        cleanupTick()
        return ["reply": "quit-fixtures", "pending": Array(cleaning).sorted()]
    }
    var menuUntil = 0.0
    func ownedMenu(_ row: [String: Any], pid: Int32) -> Bool {
        guard kind == "runtime", num(row, kCGWindowLayer) > 0, ProcessInfo.processInfo.systemUptime < menuUntil, bound(pid),
              NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "org.sleight.bench.rt25-witness",
              let frame = bounds(row) else { return false }
        let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.01)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(app, Float(frame.midX), Float(frame.midY), &hit) == .success else { return false }
        let measured = measureAXParents(hit, pid: pid, window: nil, menuOnly: true)
        // A missing AXMenu parent is the question being measured. Never require
        // an application terminal here, but every visited node must keep its pid.
        return menuParentAccepted(measured)
    }
    func sample() -> [String: Any] {
        if kind == "renderer" {
            let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
            let now = ProcessInfo.processInfo.systemUptime
            var st = stat()
            let held = Darwin.lstat("/tmp/sleight-hold", &st) == 0 || errno != ENOENT
            if let reason = rendererState.sample(now: now, idle: idle, held: held) { fault(reason, read: "RENDERER_STATE", value: "held=\(held),idleMs=\(idle * 1000),elapsed=\(now - began)") }
            if getppid() != parent { fault("PARENT_EXIT", read: "PARENT_PID", value: String(getppid())) }
            if now - began > 2100 { fault("DEADLINE_EXCEEDED", read: "ELAPSED_SECONDS", value: String(now - began)) }
            samples += 1
            return ["record": "guard", "samples": samples, "hidIdleMs": idle * 1000, "failedRead": stopRead as Any? ?? NSNull(), "stop": stop as Any? ?? NSNull()]
        }
        let now = ProcessInfo.processInfo.systemUptime
        var signals = GuardSignals()
        if last > 0 { signals.gapMs = (now - last) * 1000; maxGap = max(maxGap, signals.gapMs) }; last = now; samples += 1
        var st = stat(); signals.held = Darwin.lstat("/tmp/sleight-hold", &st) == 0 || errno != ENOENT
        if getppid() != parent { fault("PARENT_EXIT", read: "PARENT_PID", value: String(getppid())) }
        checkDeadline(now)
        var idle = 0.0
        let (personActive, reset) = sampleIdle(&idleDetector, afterAX: {
            let current = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
            signals.frontChanged = focusDetector.changed(current == front ? sameFocusedWindow(current) : false)
        }, readIdle: {
            idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!)
            return idle
        }, clock: { ProcessInfo.processInfo.systemUptime })
        guard let event = hostRead("CG_EVENT", { CGEvent(source: nil) }) else { return ["record": "guard", "stop": stop!, "failedRead": stopRead!] }
        signals.pointerChanged = event.location != pointer
        if let reset = reset { emit(reset) }
        signals.personActive = personActive && !observeOnly
        if kind == "runtime", launchPermits.contains("com.google.Chrome") || chromePID != nil {
            let running = fixtureProcesses(NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome"))
            if !chromeProcessesAllowed(running, permitted: launchPermits.contains("com.google.Chrome"), chromePID: chromePID) { fault("FOREIGN_WINDOW", read: "CHROME_PROCESS_COUNT", value: String(running.count)) }
        }
        guard let rows = hostRead("CG_WINDOWS", { windows() }) else { return ["record": "guard", "stop": stop!, "failedRead": stopRead!] }
        let overlayIDs = overlayExemption(rows)
        var overlayMetadata: [Int: (pid: Int32, layer: Int)] = [:]
        for row in rows where overlayIDs.contains(num(row, kCGWindowNumber)) {
            overlayMetadata[num(row, kCGWindowNumber)] = (Int32(num(row, kCGWindowOwnerPID)), num(row, kCGWindowLayer))
        }
        for record in systemOverlays.sample(overlayMetadata, now: now, utcMs: Date().timeIntervalSince1970 * 1000) { emit(record) }
        for pid in own where pid != vmPID {
            if let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated {
                if let birth = identity(app), birth != ownStarts[pid] { identityFault("PROCESS_START") }
            }
        }
        var newForeign: [[String: Any]] = [], safetyRows: [FixtureWindow] = [], overlays: [[String: Any]] = []
        for w in rows where num(w, kCGWindowLayer) >= 0 && !overlayIDs.contains(num(w, kCGWindowNumber)) {
            let pid = Int32(num(w, kCGWindowOwnerPID)), id = num(w, kCGWindowNumber)
            let app = NSRunningApplication(processIdentifier: pid), bundle = app?.bundleIdentifier ?? ""
            let name = w[kCGWindowName as String] as? String ?? ""
            let evidence = windowEvidence(pid: pid, bundle: bundle, id: id, owner: w[kCGWindowOwnerName as String] as? String ?? "",
                name: name, layer: num(w, kCGWindowLayer), frame: bounds(w), alpha: w[kCGWindowAlpha as String] as? Double)
            let owner = w[kCGWindowOwnerName as String] as? String ?? ""
            let overlay = allowedOverlayWindow(w)
            if overlay || name == "StatusIndicator" || name == "Software Cursor" ||
                app?.bundleURL?.resolvingSymlinksInPath().path.hasPrefix("/Applications/ChatGPT.app/") == true { overlays.append(evidence) }
            if overlay { continue }
            let fixture = kind == "runtime" && fixtureSamplingAllowed(bundle: bundle, pid: pid, permitted: launchPermits.contains(bundle),
                owned: own.contains(pid), bound: bound(pid), chromePID: chromePID) && (identity(app) ?? 0) >= started
            if !own.contains(pid) && !fixture { recordForeign(evidence) }
            if !baseline.contains(id) && !own.contains(pid) && !fixture {
                newForeign.append(evidence)
            }
            if fixture {
                if bundle != "com.google.Chrome" || chromePID == pid {
                    own.insert(pid)
                    let date = identity(app)
                    if ownStarts[pid] == nil { ownStarts[pid] = date }
                    if ownStarts[pid] != date { fault("IDENTITY_CHANGED", read: "FIXTURE_PROCESS_BIRTH", value: date.map { String($0) } ?? "nil", pid: pid) }
                }
                let title = w[kCGWindowName as String] as? String ?? ""
                if bundle == "com.apple.TextEdit" && !fixtureTitle(title) && !cleaning.contains(pid) {
                    newForeign.append(evidence); recordForeign(evidence)
                }
            }
            safetyRows.append(FixtureWindow(pid: pid, layer: num(w, kCGWindowLayer), bundle: bundle,
                baseline: baseline.contains(id), owned: own.contains(pid), fixture: fixture, cleaning: cleaning.contains(pid),
                menu: fixture && ownedMenu(w, pid: pid),
                titleAllowed: bundle != "com.apple.TextEdit" || fixtureTitle(w[kCGWindowName as String] as? String ?? "")))
        }
        // Negative layers still count toward a fixture's total, as in the original guard.
        for w in rows where num(w, kCGWindowLayer) < 0 {
            let pid = Int32(num(w, kCGWindowOwnerPID))
            if !own.contains(pid) {
                recordForeign(windowEvidence(pid: pid, bundle: NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "",
                    id: num(w, kCGWindowNumber), owner: w[kCGWindowOwnerName as String] as? String ?? "",
                    name: w[kCGWindowName as String] as? String ?? "", layer: num(w, kCGWindowLayer), frame: bounds(w), alpha: w[kCGWindowAlpha as String] as? Double))
            }
            safetyRows.append(FixtureWindow(pid: Int32(num(w, kCGWindowOwnerPID)), layer: num(w, kCGWindowLayer), bundle: ""))
        }
        let windowSignals = fixtureWindowSignals(safetyRows, now: ProcessInfo.processInfo.systemUptime, menuUntil: menuUntil)
        signals.permission = windowSignals.permission; signals.foreign = windowSignals.foreign; signals.blocked = windowSignals.blocked
        for pid in own {
            if NSRunningApplication(processIdentifier: pid)?.isTerminated != false { own.remove(pid); pendingAXWindows.removeValue(forKey: pid); continue }
            let app = AXUIElementCreateApplication(pid); AXUIElementSetMessagingTimeout(app, 0.03)
            guard let list = windowRead(pid, overlay: !overlayIDs.isEmpty, now: now,
                required: { NSRunningApplication(processIdentifier: pid)?.isTerminated == false },
                read: { attr(app, "AXWindows") as? [AXUIElement] }) else { continue }
            for w in list {
                if expectedCleanupSheet(w, pid: pid) { continue }
                let sheets = attr(w, "AXSheets") as? [AXUIElement] ?? []
                if sheets.contains(where: { discardButton($0, pid: pid, parent: w) == nil }) || (attr(w, "AXModal") as? Bool) == true { signals.blocked = true }
            }
        }
        if !newForeign.isEmpty { foreignWindows = newForeign.map(publishedWindowEvidence) }
        if !overlays.isEmpty { overlayWindows = overlays.map(publishedWindowEvidence) }
        sampleSignals(signals, now: now, lockValid: { liveLockValid() })
        if kind == "vm" || uc3fPolicy != nil { checkVM(rows.filter { !overlayIDs.contains(num($0, kCGWindowNumber)) }) }
        cleanupTick()
        return ["record": "guard", "samples": samples, "maxGapMs": maxGap, "frontmostPID": front, "hidIdleMs": idle * 1000,
            "hidResets": idleDetector.totalResets, "observeOnly": observeOnly, "ownerObserved": ownerPresentHandsOff, "foreignWindows": foreignWindows, "overlayWindows": overlayWindows,
            "systemOverlayActive": !overlayIDs.isEmpty || !pendingAXWindows.isEmpty,
            "pointerUnchanged": !signals.pointerChanged, "frontmostUnchanged": !signals.frontChanged,
            "identityField": identityField as Any? ?? NSNull(), "failedRead": stopRead as Any? ?? NSNull(), "stop": stop as Any? ?? NSNull()]
    }
    var vmPID: Int32 = 0, vmWindow = 0, vmTitle = "", vmStart: UInt64?, vmBounds: CGRect?
    var identityField: String?
    func identityFault(_ field: String) {
        if stop == nil { identityField = field; fault("IDENTITY_CHANGED", read: field, value: "mismatch", pid: vmPID) }
    }
    var captureItem: AXUIElement?, captureReadAt = -Double.infinity, captureReads = 0
    func bindCaptureItem() -> Bool {
        let app = AXUIElementCreateApplication(vmPID); AXUIElementSetMessagingTimeout(app, 0.03)
        // Older UTM puts Capture Input in its menu bar. UTM 5.0.8 has no such menu item: the VM window's toolbar
        // holds an AXCheckBox whose AXDescription is "Capture Input" (read live 2026-11-01). Exactly one match
        // across both places binds. None or several refuse.
        // A walk that times out or hits its limit refuses, since the true match count is then unknown.
        guard !vmTitle.isEmpty else { return false }
        var matches: [AXUIElement] = []
        if let bar = attr(app, "AXMenuBar"), CFGetTypeID(bar) == AXUIElementGetTypeID() {
            guard let nodes = tree(bar as! AXUIElement, limit: 512) else { return false }
            matches += nodes.filter { captureControl($0) == "AXMenuItem" }
        }
        for w in attr(app, "AXWindows") as? [AXUIElement] ?? [] where attr(w, "AXTitle") as? String == vmTitle {
            guard let nodes = tree(w, limit: 512) else { return false }
            matches += nodes.filter { captureControl($0) == "AXCheckBox" }
        }
        guard matches.count == 1 else { return false }; captureItem = matches[0]; return true
    }
    func captureControl(_ e: AXUIElement) -> String? {
        let role = attr(e, "AXRole") as? String
        if role == "AXMenuItem", attr(e, "AXTitle") as? String == "Capture Input" { return role }
        if role == "AXCheckBox", attr(e, "AXDescription") as? String == "Capture Input" { return role }
        return nil
    }
    func checkVM(_ rows: [[String: Any]], readStart: ((Int32) -> UInt64?)? = nil, readCapture: (() -> Bool?)? = nil, clock: (() -> Double)? = nil) {
        let list = rows.filter { num($0, kCGWindowOwnerPID) == Int(vmPID) }
        let currentStart = processStart(vmPID, read: readStart ?? { kernelInfo($0)?.start })
        guard let currentStart = currentStart else { fault("PROCESS_START_UNREADABLE", read: "KERNEL_PROCESS_BIRTH", value: "nil", pid: vmPID); return }
        guard currentStart == vmStart else { identityFault("PROCESS_START"); return }
        guard list.count == 1 else { identityFault("WINDOW_COUNT"); return }
        guard num(list[0], kCGWindowNumber) == vmWindow else { identityFault("WINDOW_ID"); return }
        guard list[0][kCGWindowName as String] as? String == vmTitle else { identityFault("WINDOW_TITLE"); return }
        guard ownerPresent ? bounds(list[0]) != nil : bounds(list[0]) == vmBounds else { identityFault("WINDOW_BOUNDS"); return }
        if !ownerPresent && !uncovered(rows, pid: vmPID, window: vmWindow) { fault("UTM_NOT_UNCOVERED", read: "UTM_UNCOVERED_MATCH", value: "false", pid: vmPID) }
        let now = clock?() ?? ProcessInfo.processInfo.systemUptime
        guard now - captureReadAt >= 0.5 else { return }
        captureReadAt = now; captureReads += 1
        guard let on = (readCapture ?? captureState)() else { fault("CAPTURE_STATE_UNKNOWN", read: "UTM_CAPTURE_STATE", value: "nil", pid: vmPID); return }
        if on && !ownerPresent { fault("CAPTURE_ON", read: "UTM_CAPTURE_STATE", value: "true", pid: vmPID) }
    }
    func captureState() -> Bool? {
        // Retained menu item only, at 2 Hz. A stale binding refuses rather than
        // falling back to a walk of UTM's application/window accessibility tree.
        var itemPID: pid_t = 0
        guard let item = captureItem, AXUIElementGetPid(item, &itemPID) == .success, itemPID == vmPID, captureControl(item) != nil
              else { return nil }
        if let mark = attr(item, "AXMenuItemMarkChar") as? String {
            return !mark.isEmpty
        } else if let value = attr(item, "AXValue") as? NSNumber {
            return value.boolValue
        }
        return nil
    }
    func receive(_ r: [String: Any]) -> [String: Any] {
        guard let op = r["op"] as? String else { return ["reply": "invalid", "error": "INVALID_REQUEST"] }
        if op == "arm", r["kind"] as? String == "renderer", !armed {
            kind = "renderer"; began = ProcessInfo.processInfo.systemUptime
            armed = true; emit(sample())
            return ["reply": op, "ok": stop == nil, "error": stop as Any? ?? NSNull()]
        }
        if op == "input-readiness", !armed { return readInputReadiness().merging(["reply": op]) { _, value in value } }
        if kind == "renderer", armed, op != "check" { return ["reply": op, "error": "INVALID_REQUEST"] }
        if op == "arm" {
            guard !armed, let k = r["kind"] as? String, ["runtime", "vm", "uc3f-away", "uc3f-present"].contains(k), AXIsProcessTrusted(), CGPreflightScreenCaptureAccess(),
                  let rows = windows(), let f = NSWorkspace.shared.frontmostApplication, let event = CGEvent(source: nil), let fw = frontWindow(f.processIdentifier) else { return ["reply": op, "error": "HOST_GRANTS_OR_STATE_REQUIRED"] }
            let handsOff = r["ownerPresentHandsOff"] as? Bool == true
            guard runtimeHandsOffAdmission(kind: k, requested: handsOff, observeOnly: r["observeOnly"] as? Bool == true,
                confirmed: r["ownerConfirmed"] as? Bool == true) else { return ["reply": op, "error": "OWNER_GO_REQUIRED"] }
            ownerPresentHandsOff = handsOff
            uc3fPolicy = nil; lockDevice = nil; lockInode = nil
            if ownerPresentHandsOff && !liveLockValid(bind: true) { return ["reply": op, "error": "LIVE_LOCK_CHANGED"] }
            kind = k; baseline = Set(rows.map { num($0, kCGWindowNumber) }); front = f.processIdentifier; focused = fw; pointer = event.location
            if let focusedValue = attr(AXUIElementCreateApplication(front), "AXFocusedWindow"), CFGetTypeID(focusedValue) == AXUIElementGetTypeID() { focusedElement = (focusedValue as! AXUIElement) }
            let initialIdle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: UInt32.max)!); began = ProcessInfo.processInfo.systemUptime
            if k.hasPrefix("uc3f-") {
                if let error = armUC3F(r, initialIdle: initialIdle, lockValid: liveLockValid(bind: true)) {
                    return ["reply": op, "error": error]
                }
            } else {
                guard initialIdle.isFinite, initialIdle >= (ownerPresentHandsOff ? 0 : 2) else { return ["reply": op, "error": "PERSON_ACTIVE"] }
            }
            idleDetector = IdleDetector(anchorTime: began, anchorIdle: initialIdle)
            idleDetector.ownerObserved = ownerPresentHandsOff
            observeOnly = k == "runtime" && r["observeOnly"] as? Bool == true
            exemptSystemOverlay = overlayOptIn(kind: k, requested: r["exemptSystemOverlay"])
            if k == "runtime" {
                if NSWorkspace.shared.runningApplications.contains(where: { ["com.apple.TextEdit", "com.apple.calculator", "org.sleight.bench.rt25-witness"].contains($0.bundleIdentifier ?? "") }) { return ["reply": op, "error": "APP_ALREADY_RUNNING"] }
            } else {
                let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.utmapp.UTM")
                guard apps.count == 1 else { return ["reply": op, "error": "UTM_NOT_OPEN"] }; vmPID = apps[0].processIdentifier
                let list = rows.filter { num($0, kCGWindowOwnerPID) == Int(vmPID) }
                guard list.count == 1, ownerPresent || front != vmPID else { return ["reply": op, "error": "UTM_NOT_BACKGROUND"] }
                vmWindow = num(list[0], kCGWindowNumber); vmTitle = list[0][kCGWindowName as String] as? String ?? ""; own.insert(vmPID); vmStart = processStart(vmPID); vmBounds = bounds(list[0])
                guard vmStart != nil else { return ["reply": op, "error": "PROCESS_START_UNREADABLE"] }
                emit(["record": "process-identity", "pid": vmPID, "kernelBirthUs": vmStart!])
                guard bindCaptureItem() else { return ["reply": op, "error": "CAPTURE_STATE_UNKNOWN"] }
            }
            armed = true; emit(sample()); return ["reply": op, "ok": stop == nil, "error": stop as Any? ?? NSNull()]
        }
        if op == "check", armed { let state = sample(); emit(state); return ["reply": op, "ok": stop == nil, "error": stop as Any? ?? NSNull(), "vmPID": vmPID, "vmWindow": vmWindow, "pointerUnchanged": state["pointerUnchanged"] ?? false] }
        if op == "optional-chrome", armed, kind == "runtime" {
            emit(sample()); if let stop = stop { return ["reply": op, "error": stop] }
            let installed = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") != nil
            let running = fixtureProcesses(NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome"))
            return optionalChrome(installed: installed, running: running).merging(["reply": op]) { _, value in value }
        }
        if op == "chrome-fixture-ready", armed, kind == "runtime" {
            emit(sample()); if let stop = stop { return ["reply": op, "error": stop] }
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.google.Chrome")
            // Refuse foreign identity before reading any of that process's windows.
            guard apps.count == 1, let date = identity(apps[0]), date >= started else { return ["reply": op, "ready": false] }
            let pid = apps[0].processIdentifier
            let permitted = launchPermits.contains("com.google.Chrome") || (chromePID == pid && bound(pid))
            guard permitted, chromePID == nil || chromePID == pid,
                  ownStarts[pid] == nil || ownStarts[pid] == date else { return ["reply": op, "ready": false] }
            let running = [FixtureProcess(pid: pid, owned: true, bound: true)]
            guard chromeFixtureReady(permitted: permitted, running: running, roles: ["AXWindow"]) else { return ["reply": op, "ready": false] }
            let roles = (attr(AXUIElementCreateApplication(apps[0].processIdentifier), "AXWindows") as? [AXUIElement])?.map { attr($0, "AXRole") as? String ?? "" }
            let ready = chromeFixtureReady(permitted: permitted, running: running, roles: roles)
            if ready {
                chromePID = pid; own.insert(pid); ownStarts[pid] = date
                launchPermits.remove("com.google.Chrome")
            }
            return ["reply": op, "ready": ready, "pid": ready ? pid as Any : NSNull()]
        }
        if op == "expect-app", armed, kind == "runtime", let bundle = r["bundle"] as? String,
           ["com.apple.TextEdit", "com.apple.calculator", "org.sleight.bench.rt25-witness", "com.google.Chrome"].contains(bundle) {
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
            guard fixtureLaunchAllowed(bundle: bundle, running: fixtureProcesses(apps)) else { return ["reply": op, "error": "APP_ALREADY_RUNNING"] }
            launchPermits.insert(bundle); return ["reply": op, "ok": true]
        }
        if op == "fixture-write", armed, kind == "runtime" {
            let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit")
            guard apps.count == 1, bound(apps[0].processIdentifier), !(fixtureBindings[apps[0].processIdentifier] ?? []).isEmpty else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            writeIntents.insert(apps[0].processIdentifier)
            emit(["record": "fixture-write-intent", "pid": apps[0].processIdentifier])
            return ["reply": op, "ok": true]
        }
        if op == "expect-document", armed, kind == "runtime", let target = r["target"] as? String, target.hasPrefix("/") {
            guard let real = canonicalPath(target), real == target, let attributes = try? FileManager.default.attributesOfItem(atPath: target),
                  attributes[.type] as? FileAttributeType == .typeRegular else { return ["reply": op, "error": "FIXTURE_DOCUMENT_REQUIRED"] }
            guard pendingDocument == nil, let rows = windows() else { return ["reply": op, "error": "FIXTURE_BINDING_REQUIRED"] }
            expectedDocuments.insert(real); pendingDocument = PendingDocument(target: real, before: Set(rows.map { num($0, kCGWindowNumber) }))
            return ["reply": op, "ok": true]
        }
        if op == "bind-document", armed, kind == "runtime" { return bindDocument().reply(pending: pendingDocument != nil) }
        if op == "engine-window", armed, kind == "runtime" {
            guard let open = r["open"] as? Bool else { return ["reply": op, "error": "INVALID_WINDOW"] }
            // Sample before opening so an earlier reset cannot gain an allowance.
            if open {
                if let stop = stop { return ["reply": op, "error": stop] }
                emit(sample()); if let stop = stop { return ["reply": op, "error": stop] }
            }
            let label = r["label"] as? String ?? "engine"
            let now = ProcessInfo.processInfo.systemUptime
            guard let allowance = open ? runtimeResetAllowance(observeOnly: observeOnly, measured: ownerPresentHandsOff ? 0 : r["allowance"] as? Int) : 0 else {
                return ["reply": op, "error": "HID_SOURCE_UNCONFIRMED"]
            }
            guard label.utf8.count <= 80, label.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || "-_:.".contains($0)) }),
                  open ? idleDetector.open(now, label: label, allowance: allowance) : idleDetector.close(now) else { return ["reply": op, "error": "INVALID_WINDOW"] }
            if recordActionWindows { emit(["record": "posted-action-window", "open": open, "window": idleDetector.window, "label": label, "uptime": now, "tailMs": 150]) }
            return ["reply": op, "window": idleDetector.window, "tailMs": 150]
        }
        if op == "quit-fixtures", armed, let bundles = r["bundles"] as? [String] { return beginCleanup(bundles) }
        if op == "cleanup-check", armed {
            emit(sample())
            return ["reply": op, "pending": Array(cleaning).sorted(), "error": cleanupError as Any? ?? NSNull(),
                "writeIntentPIDs": Array(writeIntents).sorted(),
                "pointerUnchanged": CGEvent(source: nil)?.location == pointer,
                "frontmostUnchanged": (NSWorkspace.shared.frontmostApplication?.processIdentifier == front ? sameFocusedWindow(front) : false) as Any? ?? NSNull()]
        }
        if ["coordinate-parent", "context-menu-parent", "expect-context-menu"].contains(op), kind == "runtime", armed {
            emit(sample()); if let stop = stop { return ["reply": op, "error": stop] }
            guard let bundle = r["bundle"] as? String,
                  ["com.apple.TextEdit", "com.apple.calculator", "org.sleight.bench.rt25-witness", "com.google.Chrome"].contains(bundle),
                  let process = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first,
                  bound(process.processIdentifier), process.processIdentifier != front else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            let pid = process.processIdentifier, ax = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(ax, 0.01)
            guard let ws = attr(ax, "AXWindows") as? [AXUIElement],
                  let window = ws.first(where: { attr($0, "AXRole") as? String == "AXWindow" }),
                  ws.filter({ attr($0, "AXRole") as? String == "AXWindow" }).count == 1,
                  let frame = rect(window), frame.width > 0, frame.height > 0 else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            if op == "expect-context-menu" {
                guard contextMenuAllowed(bundle: bundle, bound: bound(pid), background: pid != front,
                    roles: ws.map { attr($0, "AXRole") as? String ?? "" }, validFrame: frame.width > 0 && frame.height > 0) else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
                menuUntil = ProcessInfo.processInfo.systemUptime + contextMenuAllowanceSeconds
                return ["reply": op, "ok": true]
            }
            var point = CGPoint.zero
            if op == "coordinate-parent" {
                guard let index = r["index"] as? Int, (0..<25).contains(index) else { return ["reply": op, "error": "INVALID_SAMPLE"] }
                point = CGPoint(x: frame.minX + frame.width * (Double(index % 5) + 0.5) / 5,
                                y: frame.minY + frame.height * (Double(index / 5) + 0.5) / 5)
            } else {
                guard bundle == "org.sleight.bench.rt25-witness", ProcessInfo.processInfo.systemUptime < menuUntil,
                      let rows = windows(), let menu = rows.first(where: { num($0, kCGWindowOwnerPID) == Int(pid) && ownedMenu($0, pid: pid) }),
                      let f = bounds(menu) else { return ["reply": op, "sample": ["refused": true, "nodes": 0, "roles": [], "reason": "MENU_UNAVAILABLE"]] }
                point = CGPoint(x: f.midX, y: f.midY)
            }
            var hit: AXUIElement?
            let status = AXUIElementCopyElementAtPosition(ax, Float(point.x), Float(point.y), &hit)
            var measured = measureAXParents(status == .success ? hit : nil, pid: pid, window: op == "coordinate-parent" ? window : nil)
            if op == "context-menu-parent", (measured["roles"] as? [String])?.contains("AXMenu") != true {
                measured["refused"] = true; measured["reason"] = "MENU_UNAVAILABLE"
            }
            emit(sample()); if let stop = stop { return ["reply": op, "error": stop] }
            return ["reply": op, "sample": measured, "axStatus": status.rawValue]
        }
        if op == "fixture-frame", kind == "runtime", armed {
            guard let bundle = r["bundle"] as? String, ["com.apple.TextEdit", "com.apple.calculator"].contains(bundle),
                  let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first, own.contains(app.processIdentifier),
                  let ws = attr(AXUIElementCreateApplication(app.processIdentifier), "AXWindows") as? [AXUIElement], ws.count == 1,
                  let f = rect(ws[0]) else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            return ["reply": op, "size": [f.width, f.height]]
        }
        if op == "cover-state", kind == "runtime", armed {
            guard let pid = r["pid"] as? Int32, own.contains(pid), NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.TextEdit",
                  let token = r["token"] as? String, token.hasPrefix("SIT1-"),
                  let ws = attr(AXUIElementCreateApplication(pid), "AXWindows") as? [AXUIElement],
                  let doc = ws.first(where: { (attr($0, "AXTitle") as? String ?? "").contains(token) }), let nodes = tree(doc) else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            let bars = nodes.filter { attr($0, "AXRole") as? String == "AXScrollBar" }
            let values = bars.compactMap { attr($0, "AXValue") as? NSNumber }.map { $0.doubleValue }
            guard !bars.isEmpty, values.count == bars.count, values.allSatisfy({ $0.isFinite }) else { return ["reply": op, "error": "COVER_SCROLL_UNAVAILABLE"] }
            return ["reply": op, "values": values]
        }
        if op == "place-cover", kind == "runtime", armed {
            guard let pid = r["pid"] as? Int32, own.contains(pid), NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.TextEdit",
                  let token = r["token"] as? String, token.hasPrefix("SIT1-"),
                  let app = NSRunningApplication.runningApplications(withBundleIdentifier: "org.sleight.bench.rt25-witness").first else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            let witness = AXUIElementCreateApplication(app.processIdentifier), te = AXUIElementCreateApplication(pid)
            guard let ws = attr(witness, "AXWindows") as? [AXUIElement], ws.count == 1, let f = rect(ws[0]),
                  let docs = attr(te, "AXWindows") as? [AXUIElement],
                  let doc = docs.first(where: { (attr($0, "AXTitle") as? String ?? "").contains(token) }) else { return ["reply": op, "error": "FIXTURE_IDENTITY"] }
            var p = f.origin, s = f.size
            guard let pv = AXValueCreate(.cgPoint, &p), let sv = AXValueCreate(.cgSize, &s),
                  AXUIElementSetAttributeValue(doc, "AXPosition" as CFString, pv) == .success,
                  AXUIElementSetAttributeValue(doc, "AXSize" as CFString, sv) == .success else { return ["reply": op, "error": "COVER_UNCONFIRMED"] }
            guard waitForCover(target: f, pointer: pointer, coverPID: pid, witnessPID: app.processIdentifier,
                sample: { CoverSample(frame: rect(doc), visible: windows()?.map { CoverWindow(pid: Int32(num($0, kCGWindowOwnerPID)), frame: bounds($0)) }) },
                now: { ProcessInfo.processInfo.systemUptime }, pause: { Thread.sleep(forTimeInterval: $0) }) else {
                return ["reply": op, "error": "COVER_OR_POINTER_UNCONFIRMED"]
            }
            return ["reply": op, "ok": true]
        }
        return ["reply": op, "error": "INVALID_REQUEST"]
    }
}
// Readiness records availability only. It creates no observer and authorizes no reset.
func inputReadiness(quartz: Bool?, hid: Int?, idle: [String: Double?]) -> [String: Any] {
    let grants: [String: String] = ["quartzListen": quartz == true ? "granted" : quartz == false ? "denied" : "unknown",
        "hidListen": hid == 0 ? "granted" : hid == 1 ? "denied" : "unknown"]
    var sources: [String: Any] = [:]
    var missing = false
    for key in ["quartzHID", "quartzSession", "ioHIDSystem"] {
        if let value = idle[key] ?? nil, value.isFinite, value >= 0 { sources[key] = value }
        else { sources[key] = NSNull(); missing = true }
    }
    let error: String? = grants.values.contains("unknown") ? "INPUT_GRANTS_UNKNOWN" :
        grants.values.contains("denied") ? "INPUT_GRANTS_DENIED" : missing ? "INPUT_IDLE_UNAVAILABLE" : nil
    return ["schema": "sleight.input-readiness/1", "drawing": false, "qualification": false,
        "grants": grants, "idleMs": sources, "ready": error == nil, "error": error as Any? ?? NSNull(),
        "permissionRequests": 0, "tapOpens": 0, "deviceOpens": 0, "actionCalls": 0]
}
func readInputReadiness() -> [String: Any] {
    let quartz = CGPreflightListenEventAccess()
    let hid = Int(IOHIDCheckAccess(kIOHIDRequestTypeListenEvent).rawValue)
    let any = CGEventType(rawValue: UInt32.max)!
    let hidIdle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: any) * 1000
    let sessionIdle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any) * 1000
    var systemIdle: Double?
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    if service != 0 {
        defer { IOObjectRelease(service) }
        if let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber {
            systemIdle = value.doubleValue / 1_000_000
        }
    }
    var result = inputReadiness(quartz: quartz, hid: hid,
        idle: ["quartzHID": hidIdle, "quartzSession": sessionIdle, "ioHIDSystem": systemIdle])
    result["pid"] = getpid()
    if let start = kernelInfo(getpid())?.start { result["processStart"] = start }
    result["os"] = ProcessInfo.processInfo.operatingSystemVersionString
    result["uptime"] = ProcessInfo.processInfo.systemUptime
    return result
}
// A name alone never exempts a window. Callers resolve the owning process's bundle URL.
func executablePath(_ pid: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
}
// Recorded live in UC2 notes/02e-live-probes.md, 2026-11-01: this exact tuple.
// StatusIndicator's layer has no saved live receipt. Keep that exception closed
// until a later authorized sitting records it; a fixture layer is not evidence.
let statusIndicatorLayer: Int? = nil
func allowedOverlayWindow(_ row: [String: Any],
    bundlePath: (Int32) -> String? = { NSRunningApplication(processIdentifier: $0)?.bundleURL?.resolvingSymlinksInPath().path },
    executable: (Int32) -> String? = { executablePath($0) }) -> Bool {
    let pid = Int32(num(row, kCGWindowOwnerPID)), owner = row[kCGWindowOwnerName as String] as? String ?? ""
    let name = row[kCGWindowName as String] as? String ?? "", layer = num(row, kCGWindowLayer)
    let root = "/Applications/ChatGPT.app"
    if let path = bundlePath(pid), path == root || path.hasPrefix(root + "/") {
        return owner == "ChatGPT Computer Use" && name == "Software Cursor" && layer == 0
    }
    let server = "/System/Library/PrivateFrameworks/SkyLight.framework/Versions/A/Resources/WindowServer"
    return executable(pid) == server && ["WindowServer", "Window Server"].contains(owner) &&
        name == "StatusIndicator" && statusIndicatorLayer == layer
}
if CommandLine.arguments.dropFirst() == ["--input-readiness"] {
    emit(readInputReadiness()); exit(0)
}
if CommandLine.arguments.dropFirst() == ["--replay-readiness"] {
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        let sources = row["idleMs"] as? [String: Double] ?? [:]
        emit(inputReadiness(quartz: row["quartz"] as? Bool, hid: row["hid"] as? Int,
            idle: sources.mapValues { Optional($0) }))
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--replay-overlays"] {
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        let window: [String: Any] = [kCGWindowOwnerPID as String: 123, kCGWindowOwnerName as String: row["owner"] ?? "",
            kCGWindowName as String: row["name"] ?? "", kCGWindowLayer as String: row["layer"] ?? -1]
        let allowed = allowedOverlayWindow(window, bundlePath: { _ in row["bundlePath"] as? String }, executable: { _ in row["executable"] as? String })
        emit(["drawing": false, "allowed": allowed, "owner": row["owner"] ?? NSNull(), "name": row["name"] ?? NSNull(), "layer": row["layer"] ?? NSNull()])
    }
    exit(0)
}
// Data-only fixture replay. Uses the host's decisions and fake quit callbacks, never NSApplication or host reads.
func replayFixtures(_ row: [String: Any]) -> [String: Any]? {
    guard let op = row["op"] as? String else { return nil }
    if op == "window-evidence" {
        let frame = (row["bounds"] as? [Double]).flatMap { values -> CGRect? in
            guard values.count == 4 else { return nil }
            return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
        }
        return windowEvidence(pid: Int32(row["pid"] as? Int ?? -1), bundle: row["bundle"] as? String ?? "", id: row["window"] as? Int ?? -1,
            owner: row["owner"] as? String ?? "", name: row["name"] as? String ?? "", layer: row["layer"] as? Int ?? -1,
            frame: frame, alpha: row["alpha"] as? Double)
    }
    let running = (row["running"] as? [[String: Any]] ?? []).map {
        FixtureProcess(pid: Int32($0["pid"] as? Int ?? 0), owned: $0["owned"] as? Bool == true, bound: $0["bound"] as? Bool == true)
    }
    let bundle = row["bundle"] as? String ?? "com.google.Chrome"
    if op == "optional-chrome" { return optionalChrome(installed: row["installed"] as? Bool == true, running: running) }
    if op == "expect-app" { return ["ok": fixtureLaunchAllowed(bundle: bundle, running: running)] }
    if op == "chrome-processes" {
        return ["stop": chromeProcessesAllowed(running, permitted: row["permitted"] as? Bool == true,
            chromePID: (row["chromePID"] as? Int).map { Int32($0) }) ? NSNull() : "FOREIGN_WINDOW" as Any]
    }
    if op == "chrome-fixture-ready" {
        return ["ready": chromeFixtureReady(permitted: row["permitted"] as? Bool == true, running: running, roles: row["roles"] as? [String])]
    }
    if op == "expect-context-menu" {
        let allowed = contextMenuAllowed(bundle: bundle, bound: row["bound"] as? Bool == true,
            background: row["background"] as? Bool == true, roles: row["roles"] as? [String] ?? [], validFrame: row["validFrame"] as? Bool == true)
        return ["ok": allowed, "menuUntil": allowed ? (row["now"] as? Double ?? 0) + contextMenuAllowanceSeconds : 0]
    }
    if op == "quit-chrome" {
        guard running.allSatisfy({ chromeCleanupAllowed(owned: $0.owned, bound: $0.bound) }) else {
            return ["error": "CLEANUP_IDENTITY_REQUIRED", "quitPIDs": [Int32]()]
        }
        var quits: [Int32] = []
        for process in running {
            guard requestFixtureQuit(bundle: "com.google.Chrome", bound: process.bound, fixtureOnly: true, edited: [],
                normal: { quits.append(process.pid); return true }, discard: { false }) else { return ["error": "CLEANUP_QUIT_REFUSED", "quitPIDs": quits] }
        }
        return ["quitPIDs": quits]
    }
    if op == "fixture-windows", let rows = row["rows"] as? [[String: Any]], let now = row["now"] as? Double, let until = row["menuUntil"] as? Double {
        let windows = rows.map { w in FixtureWindow(pid: Int32(w["pid"] as? Int ?? 0), layer: w["layer"] as? Int ?? -1,
            bundle: w["bundle"] as? String ?? "", baseline: w["baseline"] as? Bool == true, owned: w["owned"] as? Bool == true,
            fixture: w["fixture"] as? Bool == true, cleaning: w["cleaning"] as? Bool == true,
            menu: menuParentAccepted(["terminal": w["hitRole"] as? String ?? "", "refused": w["hitPID"] as? Int != w["pid"] as? Int]),
            titleAllowed: w["titleAllowed"] as? Bool != false) }
        return ["stop": fixtureWindowSignals(windows, now: now, menuUntil: until).reason as Any? ?? NSNull()]
    }
    return nil
}
// End data-only fixture replay.
if CommandLine.arguments.dropFirst() == ["--replay-fixtures"] {
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let result = replayFixtures(row) else { exit(65) }
        emit(result.merging(["drawing": false]) { _, value in value })
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--replay-idle"] {
    // Data-only entry point. Never creates NSApplication or reads host state.
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let initial = row["initialIdle"] as? Double, let steps = row["steps"] as? [[String: Any]], steps.count <= 10000 else { exit(65) }
        var detector = IdleDetector(anchorTime: 0, anchorIdle: initial), stop: String?, records: [[String: Any]] = []
        detector.ownerObserved = row["ownerPresentHandsOff"] as? Bool == true
        for step in steps {
            guard let op = step["op"] as? String, let t = step["t"] as? Double else { exit(65) }
            if op == "open" { if !detector.open(t, label: "replay", allowance: step["allowance"] as? Int ?? 1) { exit(65) } }
            else if op == "close" { if !detector.close(t) { exit(65) } }
            else if op == "sample", let idle = step["idle"] as? Double {
                let (active, record) = detector.sample(t, idle: idle)
                if let record = record { records.append(record) }
                if active { stop = "PERSON_ACTIVE" }
            } else { exit(65) }
        }
        emit(["drawing": false, "stop": stop as Any? ?? NSNull(), "resets": records])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--dump-hands-off"] {
    while let line = readLine() {
        guard let data = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        let g = Guard(); g.kind = "runtime"; g.ownerPresentHandsOff = true
        if let fault = row["fault"] as? String { g.fault(fault) }
        var signals = GuardSignals()
        signals.held = row["held"] as? Bool == true; signals.gapMs = row["gapMs"] as? Double ?? 20
        signals.personActive = row["invalidIdle"] as? Bool == true
        signals.frontChanged = row["frontChanged"] as? Bool == true; signals.pointerChanged = row["pointerChanged"] as? Bool == true
        signals.foreign = row["foreign"] as? Bool == true; signals.permission = row["permission"] as? Bool == true
        signals.blocked = row["blocked"] as? Bool == true
        g.sampleSignals(signals, now: 0, lockValid: { row["lockValid"] as? Bool != false })
        if let later = row["laterFault"] as? String { g.fault(later) }
        emit(["drawing": false, "stop": g.stop as Any? ?? NSNull()])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--replay-renderer"] {
    while let line = readLine() {
        guard let data = line.data(using: .utf8),
              let steps = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], steps.count <= 10000 else { exit(65) }
        var state = RendererSittingState(), stops: [Any] = []
        for step in steps {
            let stop = state.sample(now: step["t"] as? Double ?? .nan,
                idle: step["idle"] as? Double ?? .nan, held: step["held"] as? Bool ?? true)
            stops.append(stop as Any? ?? NSNull())
        }
        emit(["drawing": false, "stops": stops])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--dump-uc3f"] {
    // Pure policy and HID replay. No NSApplication, lock stat or host sampling.
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let presence = row["presence"] as? String, let cap = row["blockSeconds"] as? Double,
              let elapsed = row["elapsed"] as? Double, let initialIdle = row["initialIdle"] as? Double,
              let idle = row["idle"] as? Double else { exit(65) }
        let policy = UC3FGuardPolicy(presence: presence, blockSeconds: cap)
        var detector = IdleDetector(anchorTime: 0, anchorIdle: initialIdle), signals = GuardSignals()
        signals.personActive = detector.sample(elapsed, idle: idle).0
        signals.held = row["held"] as? Bool == true
        signals.gapMs = row["gapMs"] as? Double ?? 20
        signals.permission = row["permission"] as? Bool == true
        signals.frontChanged = row["frontChanged"] as? Bool == true
        signals.pointerChanged = row["pointerChanged"] as? Bool == true
        signals.foreign = row["foreign"] as? Bool == true
        let lockValid = row["lockValid"] as? Bool == true
        let stopped = policy.arm(ownerConfirmed: row["ownerConfirmed"] as? Bool == true, initialIdle: initialIdle, lockValid: lockValid) ??
            policy.reason(signals, elapsed: elapsed, lockValid: row["lockStillValid"] as? Bool ?? lockValid)
        emit(["drawing": false, "stop": stopped as Any? ?? NSNull()])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--dump-uc3f-wiring"] {
    // Executes Guard's arm, sample and VM decisions with synthetic metadata.
    // No NSApplication, AX calls, CG events, lock stat or live host sampling.
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = row["kind"] as? String, ["vm", "uc3f-away", "uc3f-present"].contains(kind),
              let elapsed = row["elapsed"] as? Double, let initialIdle = row["initialIdle"] as? Double else { exit(65) }
        let g = Guard(); g.kind = kind; g.began = 0
        let error = kind == "vm" ? nil : g.armUC3F(row, initialIdle: initialIdle, lockValid: row["lockValid"] as? Bool == true)
        if let error = error { g.fault(error) }
        var signals = GuardSignals()
        signals.held = row["held"] as? Bool == true; signals.gapMs = row["gapMs"] as? Double ?? 20
        signals.personActive = row["personActive"] as? Bool == true
        signals.frontChanged = row["frontChanged"] as? Bool == true; signals.pointerChanged = row["pointerChanged"] as? Bool == true
        signals.foreign = row["foreign"] as? Bool == true; signals.permission = row["permission"] as? Bool == true
        signals.blocked = row["blocked"] as? Bool == true
        g.checkDeadline(elapsed)
        g.sampleSignals(signals, now: elapsed, lockValid: { row["lockStillValid"] as? Bool ?? (row["lockValid"] as? Bool == true) })
        g.vmPID = 7; g.vmWindow = 70; g.vmTitle = "fixture-vm"; g.vmStart = 10_000_000
        g.vmBounds = CGRect(x: 0, y: 0, width: 100, height: 100)
        func vmRow(_ id: Int, _ title: String, _ frame: CGRect) -> [String: Any] {
            [kCGWindowOwnerPID as String: 7, kCGWindowNumber as String: id, kCGWindowName as String: title,
             kCGWindowBounds as String: frame.dictionaryRepresentation]
        }
        var rows = [vmRow(row["window"] as? Int ?? 70, row["title"] as? String ?? "fixture-vm",
            row["moved"] as? Bool == true ? CGRect(x: 50, y: 50, width: 200, height: 150) : g.vmBounds!)]
        if row["secondWindow"] as? Bool == true { rows.append(vmRow(71, "other-vm", g.vmBounds!)) }
        if row["missingWindow"] as? Bool == true { rows = [] }
        if row["missingBounds"] as? Bool == true { rows[0].removeValue(forKey: kCGWindowBounds as String) }
        g.checkVM(rows, readStart: { _ in row["missingStart"] as? Bool == true ? nil : row["restarted"] as? Bool == true ? 20_000_000 : g.vmStart },
            readCapture: { row["captureOn"] as? Bool }, clock: { elapsed })
        emit(["drawing": false, "ownerPresent": g.ownerPresent, "stop": g.stop as Any? ?? NSNull(), "identityField": g.identityField as Any? ?? NSNull(), "captureReads": g.captureReads])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--dump-overlay"] {
    // Synthetic window rows only. No NSApplication, AX, CG events or host sampling.
    while let line = readLine() {
        guard line.utf8.count < 65536, let data = line.data(using: .utf8),
              let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let kind = row["kind"] as? String,
              ["runtime", "vm", "uc3f-away", "uc3f-present", "renderer"].contains(kind),
              let windows = row["windows"] as? [[String: Any]] else { exit(65) }
        let g = Guard(); g.kind = kind
        g.exemptSystemOverlay = overlayOptIn(kind: kind, requested: row["exemptSystemOverlay"])
        let mapped: [[String: Any]] = windows.map { window in
            var out: [String: Any] = [kCGWindowOwnerPID as String: window["pid"] as? Int ?? -1,
                kCGWindowNumber as String: window["id"] as? Int ?? -1, kCGWindowLayer as String: window["layer"] as? Int ?? -1]
            if window["baseline"] as? Bool == true { out["baseline"] = true }
            if window["owned"] as? Bool == true { out["owned"] = true }
            return out
        }
        let ids = g.overlayExemption(mapped, readExecutable: { pid in
            windows.first { ($0["pid"] as? Int) == Int(pid) }?["executable"] as? String
        })
        let foreign = mapped.contains { item in
            num(item, kCGWindowLayer) >= 0 && !ids.contains(num(item, kCGWindowNumber)) &&
                item["baseline"] as? Bool != true && item["owned"] as? Bool != true
        }
        emit(["drawing": false, "kind": kind, "exempt": g.exemptSystemOverlay, "overlayIDs": ids.sorted(),
            "foreign": foreign, "stop": foreign ? "FOREIGN_WINDOW" : NSNull()])
    }
    exit(0)
}
if CommandLine.arguments.dropFirst() == ["--selftest"] {
    var passed = 0, failed = 0
    func expect(_ value: Bool) { if value { passed += 1 } else { failed += 1 } }
    expect(GuardSignals().reason == nil)
    var s = GuardSignals(); s.held = true; expect(s.reason == "TIMED_WINDOW_HOLD")
    s = GuardSignals(); s.gapMs = 501; expect(s.reason == "GUARD_STALE")
    s = GuardSignals(); s.frontChanged = true; expect(s.reason == "FRONTMOST_CHANGED")
    s = GuardSignals(); s.pointerChanged = true; expect(s.reason == "POINTER_CHANGED")
    s = GuardSignals(); s.personActive = true; expect(s.reason == "PERSON_ACTIVE")
    s = GuardSignals(); s.permission = true; expect(s.reason == "PERMISSION_PROMPT")
    s = GuardSignals(); s.foreign = true; expect(s.reason == "FOREIGN_WINDOW")
    s = GuardSignals(); s.blocked = true; expect(s.reason == "WINDOW_BLOCKED")
    func row(_ pid: Int, _ id: Int, _ x: Double = 0, _ alpha: Double = 1) -> [String: Any] {
        [kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id, kCGWindowAlpha as String: alpha,
         kCGWindowBounds as String: CGRect(x: x, y: 0, width: 100, height: 100).dictionaryRepresentation]
    }
    expect(uncovered([row(1, 2)], pid: 1, window: 2))
    expect(!uncovered([], pid: 1, window: 2))
    expect(!uncovered([row(1, 3)], pid: 1, window: 2))
    expect(!uncovered([row(2, 4), row(1, 2)], pid: 1, window: 2))
    expect(uncovered([row(2, 4, 200), row(1, 2)], pid: 1, window: 2))
    expect(uncovered([row(2, 4, 0, 0), row(1, 2)], pid: 1, window: 2))
    expect(!uncovered([row(1, 3), row(1, 2)], pid: 1, window: 2))
    let g = Guard(); g.fault("PERSON_ACTIVE"); g.fault("FOREIGN_WINDOW"); expect(g.stop == "PERSON_ACTIVE")
    g.armed = true; g.kind = "runtime"
    expect(g.idleDetector.open(0, label: "failed-call"))
    expect(g.receive(["op": "engine-window", "open": false])["error"] == nil)
    expect(g.receive(["op": "engine-window", "open": true])["error"] as? String == "PERSON_ACTIVE")
    var focus = FocusDetector()
    expect(!focus.changed(nil)); expect(!focus.changed(nil)); expect(focus.changed(nil))
    expect(!focus.changed(true)); expect(!focus.changed(nil)); expect(focus.changed(false))
    expect(discardAllowed(cleaning: true, bound: true, attached: true, titles: ["Don't Save", "Cancel", "Save"]))
    expect(!discardAllowed(cleaning: false, bound: true, attached: true, titles: ["Don't Save"]))
    expect(!discardAllowed(cleaning: true, bound: false, attached: true, titles: ["Don't Save"]))
    expect(!discardAllowed(cleaning: true, bound: true, attached: false, titles: ["Don't Save"]))
    expect(!discardAllowed(cleaning: true, bound: true, attached: true, titles: ["Don't Save", "Allow"]))
    expect(!discardAllowed(cleaning: true, bound: true, attached: true, titles: ["Don't Save", "Don't Save"]))
    expect(ownedDocument(title: "SIT1-owned.txt", path: "/fixture/owned.txt", expected: ["/fixture/owned.txt"]))
    expect(!ownedDocument(title: "SIT1-owned.txt", path: "/fixture/other.txt", expected: ["/fixture/owned.txt"]))
    expect(ownedDocument(title: "unrelated.txt", path: "/fixture/owned.txt", expected: ["/fixture/owned.txt"]))
    expect(!ownedDocument(title: "SIT1-owned.txt", path: nil, expected: ["/fixture/owned.txt"]))
    expect(fixtureCandidate(title: "SIT1-owned.txt", path: nil, target: "/fixture/SIT1-owned.txt", fresh: true))
    expect(fixtureCandidate(title: "SIT1-owned", path: nil, target: "/fixture/SIT1-owned.txt", fresh: true))
    expect(!fixtureCandidate(title: "SIT1-owned.txt", path: nil, target: "/fixture/SIT1-owned.txt", fresh: false))
    expect(!fixtureCandidate(title: "SIT1-owned.txt", path: "/other/SIT1-owned.txt", target: "/fixture/SIT1-owned.txt", fresh: true))
    expect(!fixtureCandidate(title: "SIT1-other.txt", path: nil, target: "/fixture/SIT1-owned.txt", fresh: true))
    expect(!fixtureCandidate(title: "private.txt", path: nil, target: "/fixture/private.txt", fresh: true))
    var idle = IdleDetector(anchorTime: 0, anchorIdle: 10)
    expect(idle.sample(0.02, idle: .nan).0)
    expect(idle.open(0.1, label: "test")); expect(!idle.open(0.2, label: "overlap"))
    expect(idle.close(0.3)); expect(!idle.close(0.4))
    expect(!idle.open(0.44, label: "tail")); expect(idle.open(0.46, label: "next"))
    // The production sampling seam: AX takes 25 ms, then 2 ms. Only the first
    // reading resets HID idle. Using the pre-AX timestamp fails the second read.
    var delayed = IdleDetector(anchorTime: 0, anchorIdle: 10), fakeNow = 0.0
    expect(delayed.open(0, label: "delayed-AX"))
    let first = sampleIdle(&delayed, afterAX: { fakeNow += 0.025 }, readIdle: { 0.010 }, clock: { fakeNow })
    expect(!first.0 && delayed.totalResets == 1)
    fakeNow += 0.020
    let second = sampleIdle(&delayed, afterAX: { fakeNow += 0.002 }, readIdle: { 0.010 + fakeNow - 0.025 }, clock: { fakeNow })
    expect(!second.0 && delayed.totalResets == 1)
    var skewed = IdleDetector(anchorTime: 0, anchorIdle: 10)
    expect(skewed.open(0, label: "old-order")); expect(!skewed.sample(0, idle: 0.010).0)
    expect(skewed.sample(0.045, idle: 0.032).0)
    for allowance in [0, 2, 3] {
        var measured = IdleDetector(anchorTime: 0, anchorIdle: 10)
        expect(measured.open(0, label: "measured", allowance: allowance))
        for n in 1...(allowance + 1) { expect(measured.sample(Double(n) * 0.02, idle: 0.001).0 == (n > allowance)) }
    }
    expect(retainedDocument(same: true, path: nil, target: "/fixture/SIT1-owned.txt", expected: ["/fixture/SIT1-owned.txt"]))
    expect(!retainedDocument(same: false, path: nil, target: "/fixture/SIT1-owned.txt", expected: ["/fixture/SIT1-owned.txt"]))
    expect(!retainedDocument(same: true, path: "/fixture/other.txt", target: "/fixture/SIT1-owned.txt", expected: ["/fixture/SIT1-owned.txt"]))
    expect(!retainedDocument(same: true, path: nil, target: "/fixture/SIT1-owned.txt", expected: []))
    expect(mayQuitDocument(edited: false, attached: false))
    expect(!mayQuitDocument(edited: true, attached: false))
    expect(!mayQuitDocument(edited: nil, attached: false))
    expect(!mayQuitDocument(edited: false, attached: true))
    expect(editedState([false, true]) == true)
    expect(editedState([nil, false]) == false)
    expect(editedState([nil, nil]) == nil)
    expect(editedState([true, nil]) == true)
    var normalQuits = 0, discardQuits = 0
    func request(_ bundle: String = "com.apple.TextEdit", bound: Bool = true, fixtureOnly: Bool = true, edited: [Bool?], writeIntent: Bool = false) -> Bool {
        requestFixtureQuit(bundle: bundle, bound: bound, fixtureOnly: fixtureOnly, edited: edited,
            writeIntent: writeIntent,
            normal: { normalQuits += 1; return true }, discard: { discardQuits += 1; return true })
    }
    expect(request(edited: [false])); expect(normalQuits == 1 && discardQuits == 0)
    expect(request(edited: [false, true])); expect(normalQuits == 1 && discardQuits == 1)
    expect(request(edited: [nil])); expect(discardQuits == 2)
    expect(!request(bound: false, edited: [true])); expect(discardQuits == 2)
    expect(!request(fixtureOnly: false, edited: [true])); expect(discardQuits == 2)
    expect(!request("com.apple.TextEdit.lookalike", edited: [true])); expect(discardQuits == 2)
    expect(request("com.apple.calculator", edited: [true])); expect(normalQuits == 2 && discardQuits == 2)
    expect(!requestFixtureQuit(bundle: "com.apple.TextEdit", bound: true, fixtureOnly: true, edited: [true], normal: { true }, discard: { false }))
    // A lost write reply can leave the AX flag stale and clean. Intent wins.
    expect(request(edited: [false], writeIntent: true))
    expect(normalQuits == 2 && discardQuits == 3)
    expect(request(edited: [false, false], writeIntent: true))
    expect(normalQuits == 2 && discardQuits == 4)
    expect(!request(bound: false, edited: [false], writeIntent: true))
    expect(!request(fixtureOnly: false, edited: [false], writeIntent: true))
    expect(discardQuits == 4)
    // Kernel identity remains exact to one microsecond and names the real parent.
    if let me = kernelInfo(getpid()) { expect(me.ppid == getppid() && me.start <= UInt64(Date().timeIntervalSince1970 * 1_000_000)) } else { expect(false) }
    expect(kernelInfo(-1) == nil)
    expect(canonicalPath("/tmp") == "/private/tmp")
    expect(canonicalPath("/private/tmp") == "/private/tmp")
    expect(canonicalPath("/private/tmp/sleight-sit1-no-such-file") == nil)
    func fakeParents(_ count: Int, terminal: String = "AXWindow", broken: Int? = nil,
                     foreign: Int? = nil, cycle: Bool = false, timeout: Bool = false) -> [String: Any] {
        return parentMeasurement(0, pid: 7, window: count - 1,
            process: { $0 == foreign ? 8 : 7 },
            role: { $0 == broken ? nil : $0 == count - 1 ? terminal : "AXGroup" },
            parent: { $0 + 1 < count ? $0 + 1 : cycle ? 0 : nil }, expired: { timeout })
    }
    expect(fakeParents(66)["refused"] as? Bool == false)
    expect(fakeParents(66)["nodes"] as? Int == 66)
    expect(fakeParents(67)["reason"] as? String == "PARENT_LIMIT")
    expect(fakeParents(3, terminal: "AXGroup")["reason"] as? String == "PARENT_UNAVAILABLE")
    expect(fakeParents(3, broken: 1)["reason"] as? String == "ROLE_UNAVAILABLE")
    expect(fakeParents(3, foreign: 1)["reason"] as? String == "FOREIGN_PID")
    expect(fakeParents(3, terminal: "AXGroup", cycle: true)["reason"] as? String == "PARENT_CYCLE")
    expect(fakeParents(3, timeout: true)["reason"] as? String == "AX_TIMEOUT")
    expect(fakeParents(1, terminal: "AXApplication")["terminal"] as? String == "AXApplication")
    let absent: Int? = nil
    expect(parentMeasurement(absent, pid: 7, window: absent, process: { _ in 7 }, role: { _ in "AXGroup" }, parent: { _ in nil })["reason"] as? String == "HIT_UNAVAILABLE")
    let menu = parentMeasurement(0, pid: 7, window: absent, process: { _ in 7 },
        role: { $0 == 0 ? "AXMenu" : "AXApplication" }, parent: { $0 == 0 ? 1 : nil })
    expect(menu["roles"] as? [String] == ["AXMenu", "AXApplication"])
    expect(menu["refused"] as? Bool == false)
    expect(parentMeasurement(0, pid: 7, window: absent, process: { _ in 7 }, role: { _ in "AXMenu" }, parent: { _ in nil })["reason"] as? String == "PARENT_UNAVAILABLE")
    expect(parentMeasurement(0, pid: 7, window: absent, process: { _ in 7 }, role: { _ in "AXMenu" }, parent: { _ in nil }, menuOnly: true)["terminal"] as? String == "AXMenu")
    // An unrelated window must not terminate an ancestry walk.
    expect(parentMeasurement(0, pid: 7, window: 1, process: { _ in 7 }, role: { _ in "AXWindow" }, parent: { _ in nil })["refused"] as? Bool == true)
    emit(["drawing": false, "passed": passed, "failed": failed]); exit(failed == 0 ? 0 : 1)
}
guard CommandLine.arguments.dropFirst() == ["--serve"] else { exit(64) }
let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
let watcher = Guard(); watcher.recordActionWindows = true
let timer = Timer(timeInterval: 0.02, repeats: true) { _ in if watcher.armed { emit(watcher.sample()) } }
RunLoop.main.add(timer, forMode: .common)
DispatchQueue.global().async {
    while let line = readLine() {
        guard line.utf8.count < 4096, let data = line.data(using: .utf8), let r = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { exit(65) }
        DispatchQueue.main.async { emit(watcher.receive(r)) }
    }
    DispatchQueue.main.async {
        watcher.recordOverlayEnd()
        emit(["record": "foreign-window-counts", "windows": watcher.foreignSeen.summary]); exit(0)
    }
}
app.run()
