// Compiled only with SLEIGHT_STAGE_BENCH and a private, instrumented production source as main.swift.
// This entry owns two target windows, a person stand-in, a backdrop and the production renderer. Never installed.
import AppKit
import Foundation
import QuartzCore
import CryptoKit
import Darwin

// BEGIN BACKDROP LIFECYCLE
// The native unit test substitutes windows that only record commands. It creates no NSApplication or NSWindow.
func stageBenchExposureSeconds(control: Bool) -> TimeInterval { control ? 180 : 240 }
func stageBenchArgumentsValid(_ args: [String]) -> Bool {
    return args == ["--hand"] || args.count == 3 && args[0] == "--hand" && args[1] == "--owner-away-file" &&
        (args[2] as NSString).isAbsolutePath
}
protocol StageBenchSurfaceWindow: AnyObject {
    var surfaceLevel: Int { get set }
    var ignoresMouseEvents: Bool { get set }
    func surfaceFront()
    func surfaceOut()
}
final class StageBenchSurface {
    let backdrop: StageBenchSurfaceWindow, targets: [StageBenchSurfaceWindow]
    let normal: Int, character: Int
    private(set) var raised = false
    private var savedTargets: [(Int, Bool)] = []
    var didEnd: (() -> Void)?
    private var timer: DispatchSourceTimer?
    private var ownerSources: [DispatchSourceFileSystemObject] = []
    private var parentSource: DispatchSourceProcess?
    // The deadline is one shot. The other sources sleep in the kernel until their watched identity changes.
    var wakeSources: [String] {
        (timer == nil ? [] : ["exposure-deadline"]) + (ownerSources.isEmpty ? [] : ["owner-file", "owner-folder"]) +
            (parentSource == nil ? [] : ["parent-exit"])
    }
    init(backdrop: StageBenchSurfaceWindow, targets: [StageBenchSurfaceWindow], normal: Int, character: Int) {
        precondition(character > normal + 2)
        self.backdrop = backdrop; self.targets = targets; self.normal = normal; self.character = character
    }
    @discardableResult func begin(timeoutSeconds: TimeInterval = 240, ownerAwayFile: String?, parentPID: pid_t = getppid()) -> Bool {
        guard !raised else { return true } // A repeated command cannot extend the exposure deadline.
        guard timeoutSeconds.isFinite && timeoutSeconds > 0 && timeoutSeconds <= 240 && stageBenchOwnerAway(ownerAwayFile),
            let path = ownerAwayFile, parentPID > 1 else { return false }
        let folder = (path as NSString).deletingLastPathComponent
        let fileFD = open(path, O_EVTONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fileFD >= 0 else { return false }
        let folderFD = open(folder, O_EVTONLY | O_CLOEXEC | O_DIRECTORY | O_NOFOLLOW)
        guard folderFD >= 0 else { close(fileFD); return false }
        let fileSource = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fileFD, eventMask: [.delete, .rename, .revoke], queue: .main)
        let folderSource = DispatchSource.makeFileSystemObjectSource(fileDescriptor: folderFD, eventMask: [.delete, .rename, .revoke], queue: .main)
        let parentSource = DispatchSource.makeProcessSource(identifier: parentPID, eventMask: .exit, queue: .main)
        fileSource.setEventHandler { [weak self] in self?.end() }
        folderSource.setEventHandler { [weak self] in self?.end() }
        parentSource.setEventHandler { [weak self] in self?.end() }
        fileSource.setCancelHandler { close(fileFD) }; folderSource.setCancelHandler { close(folderFD) }
        ownerSources = [fileSource, folderSource]; self.parentSource = parentSource
        fileSource.resume(); folderSource.resume(); parentSource.resume()
        // Close the setup race before raising. A later removal/rename or parent exit is retained by the armed source.
        guard stageBenchOwnerAway(path), getppid() == parentPID else { cancelWatches(); return false }
        savedTargets = targets.map { ($0.surfaceLevel, $0.ignoresMouseEvents) }
        targets.forEach { $0.ignoresMouseEvents = true; $0.surfaceLevel = normal + 2 }
        backdrop.surfaceLevel = normal + 1; backdrop.surfaceFront(); raised = true
        let source = DispatchSource.makeTimerSource(queue: .main)
        source.schedule(deadline: .now() + timeoutSeconds, leeway: .milliseconds(10))
        source.setEventHandler { [weak self] in self?.end() }
        source.resume(); timer = source
        return true
    }
    private func cancelWatches() {
        ownerSources.forEach { $0.cancel() }; ownerSources = []
        parentSource?.cancel(); parentSource = nil
    }
    func end() {
        // Remove the covering window before lowering anything, on end, protocol failure and all graceful stops.
        timer?.cancel(); timer = nil
        cancelWatches()
        backdrop.surfaceOut(); backdrop.surfaceLevel = normal - 1
        for (target, saved) in zip(targets, savedTargets) {
            target.surfaceLevel = saved.0; target.ignoresMouseEvents = saved.1
        }
        savedTargets = []; raised = false
        didEnd?()
    }
    deinit { timer?.cancel(); cancelWatches() }
}
func stageBenchOwnerAway(_ path: String?) -> Bool {
    guard let path = path, (path as NSString).isAbsolutePath else { return false }
    var directory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &directory) && !directory.boolValue
}
private var stageBenchExitCleanup: (() -> Void)?
private var stageBenchStopSources: [DispatchSourceSignal] = []
func stageBenchCleanupOnMain() {
    if Thread.isMainThread { stageBenchExitCleanup?() }
    else { DispatchQueue.main.sync { stageBenchExitCleanup?() } }
}
func stageBenchInstallStops(_ cleanup: @escaping () -> Void) {
    stageBenchExitCleanup = cleanup
    atexit { stageBenchCleanupOnMain() }
    for number in [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGPIPE] {
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
        source.setEventHandler { stageBenchCleanupOnMain(); exit(128 + number) }
        source.resume(); stageBenchStopSources.append(source)
    }
}
// END BACKDROP LIFECYCLE

final class StageBenchBackdropPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
extension NSPanel: StageBenchSurfaceWindow {
    var surfaceLevel: Int { get { level.rawValue } set { level = NSWindow.Level(rawValue: newValue) } }
    func surfaceFront() { orderFrontRegardless() }
    func surfaceOut() { orderOut(nil) }
}
var stageBenchFixtureWindowIDs = Set<UInt32>()
// Only the private benchmark source calls this adapter. Production target discovery expects normal-level windows.
// Preserve the actual helper list for judging; normalize only our three raised fixture identities for world lookup.
func stageBenchWorldSnapshot(_ rows: [[String: Any]]?) -> [[String: Any]]? {
    rows?.map { original in
        var row = original
        if (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid(),
            let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
            stageBenchFixtureWindowIDs.contains(id),
            (row[kCGWindowLayer as String] as? NSNumber)?.intValue == NSWindow.Level.normal.rawValue + 2 {
            row[kCGWindowLayer as String] = NSWindow.Level.normal.rawValue
        }
        return row
    }
}

// BEGIN PROCESS TREE COST
// Kernel child totals survive waitpid, so subsecond microphone/decode children are charged even between polls.
private let stageBenchSpawnLock = NSLock()
private var stageBenchQuerySpawnCount = 0
private var stageBenchWorkerPID: pid_t?, stageBenchWorkerStart: UInt64?
private let stageBenchStartID = UUID().uuidString
func stageBenchRecordQuerySpawn(_ pid: pid_t) {
    var info = rusage_info_v2()
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
    }
    stageBenchSpawnLock.lock(); defer { stageBenchSpawnLock.unlock() }
    stageBenchQuerySpawnCount += 1; stageBenchWorkerPID = pid
    stageBenchWorkerStart = result == 0 ? info.ri_proc_start_abstime : nil
}
func stageBenchProcessTree() -> [String: Any]? {
    func usage(_ pid: pid_t) -> rusage_info_v2? {
        var info = rusage_info_v2()
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
        }
        return result == 0 ? info : nil
    }
    func children(_ pid: pid_t) -> [pid_t]? {
        var ids = [pid_t](repeating: 0, count: 32)
        let count = proc_listchildpids(pid, &ids, Int32(ids.count * MemoryLayout<pid_t>.stride))
        guard count >= 0, count < ids.count else { return nil }
        return ids.prefix(Int(count)).filter { $0 > 0 }.sorted()
    }
    func tree(_ pid: pid_t, _ depth: Int) -> (cpu: UInt64, childrenCpu: UInt64, rss: UInt64, pkg: UInt64, interrupts: UInt64,
        childrenPkg: UInt64, childrenInterrupts: UInt64, live: Int, reapedCpu: UInt64)? {
        guard depth < 8, let before = usage(pid), let ids = children(pid) else { return nil }
        var cpu: UInt64 = 0, rss: UInt64 = 0, pkg: UInt64 = 0, interrupts: UInt64 = 0, live = 0
        for id in ids {
            guard let child = tree(id, depth + 1) else { return nil }
            cpu += child.cpu; rss += child.rss; pkg += child.pkg; interrupts += child.interrupts; live += child.live + 1
        }
        guard let after = usage(pid), children(pid) == ids, before.ri_proc_start_abstime == after.ri_proc_start_abstime,
            before.ri_child_user_time == after.ri_child_user_time, before.ri_child_system_time == after.ri_child_system_time,
            before.ri_child_pkg_idle_wkups == after.ri_child_pkg_idle_wkups,
            before.ri_child_interrupt_wkups == after.ri_child_interrupt_wkups else { return nil }
        let childCpu = after.ri_child_user_time + after.ri_child_system_time + cpu
        let childrenPkg = after.ri_child_pkg_idle_wkups + pkg, childrenInterrupts = after.ri_child_interrupt_wkups + interrupts
        return (after.ri_user_time + after.ri_system_time + childCpu, childCpu, after.ri_resident_size + rss,
            after.ri_pkg_idle_wkups + childrenPkg, after.ri_interrupt_wkups + childrenInterrupts, childrenPkg, childrenInterrupts, live,
            after.ri_child_user_time + after.ri_child_system_time)
    }
    for _ in 0..<3 {
        guard let ids = children(getpid()), let value = tree(getpid(), 0), children(getpid()) == ids else { continue }
        // proc_pid_rusage reports Mach absolute time units, which differ from nanoseconds on Apple silicon.
        var timebase = mach_timebase_info_data_t(); guard mach_timebase_info(&timebase) == KERN_SUCCESS else { return nil }
        let secondsPerTick = Double(timebase.numer) / Double(timebase.denom) / 1e9
        stageBenchSpawnLock.lock()
        let spawns = stageBenchQuerySpawnCount, workerPID = stageBenchWorkerPID, workerStart = stageBenchWorkerStart
        stageBenchSpawnLock.unlock()
        var worker: [String: Any]?
        if let pid = workerPID, let start = workerStart, ids.contains(pid),
            let info = usage(pid), info.ri_proc_start_abstime == start {
            worker = ["pid": pid, "startID": String(pid) + ":" + String(start),
                "cpuS": Double(info.ri_user_time + info.ri_system_time) * secondsPerTick]
        }
        return ["cpuS": Double(value.cpu) * secondsPerTick, "selfCpuS": Double(value.cpu - value.childrenCpu) * secondsPerTick,
            "childrenCpuS": Double(value.childrenCpu) * secondsPerTick, "rssKb": Double(value.rss) / 1024,
            "reapedChildrenCpuS": Double(value.reapedCpu) * secondsPerTick, "microphoneWorker": worker as Any? ?? NSNull(),
            "nonWorkerChildren": value.live - (worker == nil ? 0 : 1),
            "packageWakeups": value.pkg, "interruptWakeups": value.interrupts, "liveChildren": value.live,
            "childrenPackageWakeups": value.childrenPkg, "childrenInterruptWakeups": value.childrenInterrupts,
            "querySpawns": spawns, "scope": "kernel self + collected descendants + live descendant tree",
            "startID": String(ProcessInfo.processInfo.processIdentifier) + ":" + String(stageBenchStartID)]
    }
    return nil
}
// END PROCESS TREE COST

func stageBenchJSON(_ row: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
// Measure one actual status serialization and write. Endpoint rusage reads add a small upper bound.
func stageBenchReplyCost(_ reply: () -> Void) -> [String: Any] {
    func cpu() -> Double? {
        var value = rusage()
        guard getrusage(RUSAGE_SELF, &value) == 0 else { return nil }
        return Double(value.ru_utime.tv_sec + value.ru_stime.tv_sec) + Double(value.ru_utime.tv_usec + value.ru_stime.tv_usec) / 1e6
    }
    let before = cpu(), began = CACurrentMediaTime()
    reply()
    let wall = CACurrentMediaTime() - began, after = cpu()
    let delta: Any = before != nil && after != nil && after! >= before! ? after! - before! as Any : NSNull()
    return ["cpuS": delta, "wallMs": wall * 1000, "replies": 1, "scope": "self CPU for one status reply, including serialization and write"]
}
func stageBenchRect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
var stageBenchInstalled: ((PerchHost, PerchPlan, PerchMetrics, SpriteStagePose?, Double) -> Void)?
var stageBenchPlanned: ((Int, PerchPlan, PerchMetrics) -> Void)?
var stageBenchPointerPosition: CGPoint?
var stageBenchPersonWindow: StageWindowKey?
var stageBenchPointerObserved: (([StageEffect], Int?, CGRect?, Double) -> Void)?

struct StageBenchInstalls {
    var ids: [String] = [], counts: [String: Int] = [:], unplanned = 0
    var records: [String: [[String: Any]]] = [:]
    var causes: [[String: Any]] = []
    mutating func expect(_ id: String) { if counts[id] == nil { ids.append(id); counts[id] = 0 } }
    mutating func record(_ id: String, hostTimeMs: Double = 0, installMs: Double = 0, cause: String = "unattributed") {
        let row: [String: Any] = ["id": id, "hostTimeMs": hostTimeMs, "installMs": installMs, "cause": cause]
        causes.append(row)
        guard let count = counts[id] else { unplanned += 1; return }
        counts[id] = count + 1
        records[id, default: []].append(row)
    }
    var perPlan: [Int] { ids.map { counts[$0]! } }
    var doubleInstalls: [[String: Any]] { ids.filter { counts[$0]! > 1 }.map { ["id": $0, "installs": records[$0] ?? []] } }
}
func stageBenchPlanID(_ seq: Int, _ plan: PerchPlan, _ metrics: PerchMetrics) -> String {
    let row: [String: Any] = ["seq": seq, "pose": plan.json(metrics.size),
        "size": [metrics.size.width, metrics.size.height], "scale": metrics.scale]
    guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}
func stageBenchModel() -> String {
    var count = 0
    guard sysctlbyname("hw.model", nil, &count, nil, 0) == 0, count > 1 else { exit(70) }
    var bytes = [CChar](repeating: 0, count: count)
    guard sysctlbyname("hw.model", &bytes, &count, nil, 0) == 0 else { exit(70) }
    let model = String(cString: bytes)
    guard !model.isEmpty else { exit(70) }; return model
}

struct StageBenchMotion {
    var positions: [(Double, CGPoint)] = [], reason: String? = nil, checked = 0, colliding = 0
    var geometry: [String: Any] = [:]
    var json: [String: Any] { ["ok": reason == nil, "reason": reason as Any? ?? NSNull(),
        "checkedSegments": checked, "collidingSegments": colliding,
        "geometry": geometry, "positions": positions.map { [$0.0, $0.1.x, $0.1.y] }, "motionSource": "scripted renderer pacing, preflighted separate path"] }
}
// Identical segment guard for the live fixture and headless regression cases. No collision exception for hanging art.
func stageBenchMotion(box: CGRect?, usable: CGRect, target: CGRect?, durationMs: Int, legacy: Bool = false,
    clear: (CGRect) -> Bool) -> StageBenchMotion {
    var result = stageBenchMotionPlan(box: box, usable: usable, target: target, durationMs: durationMs, legacy: legacy, clear: clear)
    result.geometry = ["box": box.map(stageBenchRect) as Any? ?? NSNull(), "target": target.map(stageBenchRect) as Any? ?? NSNull(),
        "usable": stageBenchRect(usable), "durationMs": durationMs]
    return result
}
func stageBenchMotionPlan(box: CGRect?, usable: CGRect, target: CGRect?, durationMs: Int, legacy: Bool,
    clear: (CGRect) -> Bool) -> StageBenchMotion {
    guard [400, 600].contains(durationMs) else { return StageBenchMotion(reason: "invalid-duration") }
    guard let box = box else { return StageBenchMotion(reason: "missing-draw") }
    let offset = legacy ? min(180, box.minX - usable.minX - 24) : min(180, usable.width - box.width - 48)
    guard offset >= 40 else { return StageBenchMotion(reason: "insufficient-offset") }
    guard let target = target else { return StageBenchMotion(reason: "missing-world") }
    let duration = Double(durationMs) / 1000, lift = durationMs == 600 ? 50.0 : 20.0
    func trial(_ end: CGPoint, _ distance: Double) -> StageBenchMotion {
        var result = StageBenchMotion()
        result.positions = (0...48).map { i in
            let t = Double(i) / 48
            return (duration * t, CGPoint(x: end.x - distance * (1 - t), y: end.y - sin(t * .pi) * lift))
        }
        for (a, b) in zip(result.positions, result.positions.dropFirst()) {
            let swept = CGRect(origin: a.1, size: box.size).union(CGRect(origin: b.1, size: box.size))
            result.checked += 1
            if !clear(swept) || swept.intersects(target) { result.colliding += 1 }
        }
        if result.colliding > 0 { result.reason = "unsafe-sweep" }
        return result
    }
    let original = trial(box.origin, offset)
    if legacy || original.reason == nil { return original }
    // The scripted pacing test may use a different clear corridor. Natural product motion is observed separately.
    for distance in [offset, 80, 40] where distance <= offset {
        for y in 0...4 { for x in 0...4 {
            let end = CGPoint(x: usable.minX + 24 + distance + Double(x) / 4 * max(0, usable.width - box.width - distance - 48),
                y: usable.minY + 24 + lift + Double(y) / 4 * max(0, usable.height - box.height - lift - 48))
            let result = trial(end, distance)
            if result.reason == nil { return result }
        } }
    }
    return original
}

// Numbered content is pre-rendered before the capture warmup, never on a delivery callback.
func stageBenchCadence(_ hz: Int, _ ms: Int) -> [CGImage] {
    let count = hz * ms / 1000
    return (0..<count).map { number in
        let image = NSImage(size: NSSize(width: 96, height: 64))
        image.lockFocus()
        NSColor(calibratedWhite: number % 2 == 0 ? 0.2 : 0.8, alpha: 1).setFill()
        NSBezierPath(rect: NSRect(x: 0, y: 0, width: 96, height: 64)).fill()
        (String(number) as NSString).draw(at: NSPoint(x: 8, y: 16), withAttributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 28, weight: .bold), .foregroundColor: NSColor.systemRed])
        image.unlockFocus()
        guard let pixels = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(70) }
        return pixels
    }
}
func stageBenchCadenceTrack(_ images: [CGImage], durationMs: Int, begin: Double) -> CAKeyframeAnimation {
    let track = CAKeyframeAnimation(keyPath: "contents")
    track.values = images + [images.last!]
    track.keyTimes = (0...images.count).map { NSNumber(value: Double($0) / Double(images.count)) }
    track.duration = Double(durationMs) / 1000; track.beginTime = begin
    // Keep the distinct warmup image until begin, so frame zero changes content inside the measured interval.
    track.calculationMode = .discrete; track.fillMode = .forwards; track.isRemovedOnCompletion = false
    return track
}

func stageBenchLayerState(_ layer: CALayer?) -> [String: Any] {
    guard let layer = layer else { return [:] }
    return ["animationKeys": (layer.animationKeys() ?? []).sorted(), "sublayerCount": layer.sublayers?.count ?? 0,
        "siblingCount": layer.superlayer.map { ($0.sublayers?.count ?? 0) - 1 } as Any? ?? NSNull(),
        "parentAnimationKeys": (layer.superlayer?.animationKeys() ?? []).sorted(), "opacity": layer.opacity]
}
@discardableResult
func stageBenchStationary(_ layer: CALayer, image: CGImage, position: CGPoint) -> [String: Any] {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.removeAllAnimations()
    layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    if let root = layer.superlayer {
        root.removeAllAnimations(); root.opacity = 1
        root.sublayers?.filter { $0 !== layer }.forEach { $0.removeFromSuperlayer() }
    }
    // Stationary content prevents geometric motion from hiding a repeated number.
    layer.position = position; layer.opacity = 1; layer.mask = nil
    layer.contentsRect = CGRect(x: 0, y: 0, width: 1, height: 1); layer.contents = image
    CATransaction.commit()
    return stageBenchLayerState(layer)
}
enum StageBenchCadenceError: Error { case install }
func stageBenchInstallCadence(source: String, layer: CALayer?, images: [CGImage], hz: Int, durationMs: Int,
    begin: Double?, position: CGPoint?) throws -> [String: Any] {
    guard source == "numbered" else { return ["cadenceInstalled": false] }
    guard let layer = layer, let begin = begin, begin.isFinite, let position = position,
        !images.isEmpty, images.count == hz * durationMs / 1000 else { throw StageBenchCadenceError.install }
    let stationary = stageBenchStationary(layer, image: images.last!, position: position)
    CATransaction.begin(); CATransaction.setDisableActions(true)
    layer.add(stageBenchCadenceTrack(images, durationMs: durationMs, begin: begin), forKey: "contents")
    CATransaction.commit()
    guard layer.animation(forKey: "contents") != nil else { throw StageBenchCadenceError.install }
    return ["cadenceInstalled": true, "stationary": stationary]
}
func stageBenchMeasuredInstall(_ scheduled: Double, clock: () -> Double = { CACurrentMediaTime() * 1000 },
    install: () -> CALayer?, control: (CALayer?, Double?) throws -> [String: Any]) rethrows -> [String: Any] {
    let began = clock(), layer = install(), ended = clock()
    let begin = layer?.animation(forKey: "position")?.beginTime
    let receipt = try control(layer, begin)
    return ["scheduledStartHostMs": scheduled, "installStartHostMs": began, "installEndHostMs": ended,
        "caBeginHostMs": begin.map { $0 * 1000 } as Any? ?? NSNull(), "transactionSubmittedHostMs": clock(),
        "layerState": stageBenchLayerState(layer)].merging(receipt) { _, b in b }
}

// Submit the complete scripted track before its original scheduled start. Moving the observation interval
// after a late install would conceal lost frames. Only the benchmark's prepared motion uses this path.
func stageBenchQuiesce(_ host: HandHost) {
    host.perch.wake?.cancel(); host.perch.wake = nil
    host.ringWake?.cancel(); host.ringWake = nil
    host.pauseOverlay.pending?.cancel(); host.pauseOverlay.pending = nil
}
enum StageBenchScheduleError: Error { case missingPosition, missedStart, productionTimers }
func stageBenchScheduleFailure(_ error: Error, source: String, timers: [String: Double], layer: CALayer?) -> [String: Any] {
    ["ok": false, "reply": "start", "error": "scheduled-motion-install", "source": source,
        "reason": String(describing: error), "motionTimers": timers, "animationKeys": layer?.animationKeys() ?? []]
}
var stageBenchScheduledStart: Double?
func stageBenchBadgeDelay(_ duration: Double, clock: () -> Double = { CACurrentMediaTime() }) -> Double {
    let now = clock()
    return duration + max(0, (stageBenchScheduledStart ?? now) - now)
}
func stageBenchScheduledInstall(_ scheduled: Double, clock: () -> Double = { CACurrentMediaTime() * 1000 },
    timers: () -> [String: Double] = { [:] }, install: () -> CALayer?, control: (CALayer?, Double?) throws -> [String: Any]) throws -> [String: Any] {
    let began = clock(), before = timers()
    guard before["perchWake", default: 0] == 0 && before["ringWake", default: 0] == 0 else { throw StageBenchScheduleError.productionTimers }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    var committed = false
    defer { if !committed { CATransaction.commit() } }
    guard let layer = install(), let original = layer.animation(forKey: "position")?.beginTime,
        original.isFinite && original > 0 else { throw StageBenchScheduleError.missingPosition }
    let shift = scheduled / 1000 - original
    func retime(_ node: CALayer) {
        for key in node.animationKeys() ?? [] {
            guard let track = node.animation(forKey: key)?.copy() as? CAAnimation else { continue }
            track.beginTime = track.beginTime == 0 ? scheduled / 1000 : track.beginTime + shift
            node.add(track, forKey: key)
        }
        node.sublayers?.forEach(retime)
        if let mask = node.mask { retime(mask) }
    }
    retime(layer.superlayer ?? layer)
    let ended = clock(), receipt = try control(layer, scheduled / 1000)
    CATransaction.commit(); committed = true
    let submitted = clock()
    guard before == timers() else { throw StageBenchScheduleError.productionTimers }
    guard began < scheduled && submitted < scheduled else { throw StageBenchScheduleError.missedStart }
    return ["productionTimersUnchanged": true, "productionTimers": before, "scheduleMode": "preinstalled", "scheduledStartHostMs": scheduled, "installStartHostMs": began,
        "installEndHostMs": ended, "caBeginHostMs": scheduled, "transactionSubmittedHostMs": submitted,
        "layerState": stageBenchLayerState(layer)].merging(receipt) { _, b in b }
}

// Real scheduling guards and the live catch's serializer, with no application or windows.
func stageBenchScheduleFailures() -> [[String: Any]] {
    ["productionTimers", "missingPosition", "missedStart"].map { subtype in
        let layer = CALayer(), track = CABasicAnimation(keyPath: "position")
        track.beginTime = 1; layer.add(track, forKey: "position")
        var timers = ["phase": 1.0]
        do {
            _ = try stageBenchScheduledInstall(1500, clock: { subtype == "missedStart" ? 1600 : 1000 }, timers: { timers }, install: {
                if subtype == "productionTimers" { timers["phase"] = 2 }
                if subtype == "missingPosition" { layer.removeAnimation(forKey: "position") }
                return layer
            }, control: { _, _ in [:] })
            return ["ok": true]
        } catch { return stageBenchScheduleFailure(error, source: "character", timers: timers, layer: layer) }
    }
}

final class StageBench {
    let host = HandHost()
    var runtime = StageRuntime(), fixtures: [NSPanel] = [], content: [CALayer] = []
    var backdrop: NSPanel?, person: NSPanel?
    var surface: StageBenchSurface?
    let ownerAwayFile: String?
    var closed = false
    var nonce: String?, last = -1, received = 0.0, startup: Double?, installTimes: [Double] = [], panels: [[String: Any]] = []
    // Cancel observer and badge wakes again at start, after prepare's parked install and recorder warmup.
    // Installing CA tracks must preserve the stage and legacy runtime deadlines.
    var motionTimers: [String: Double] {
        let perch = host.perch, stage = perch.stage
        var result = ["perchWake": perch.wake == nil ? 0.0 : 1.0, "ringWake": host.ringWake == nil ? 0.0 : 1.0,
            "reaction": stage.reactionUntil ?? -1, "phase": stage.phaseUntil ?? -1,
            "parked": stage.parkedAt ?? -1, "stable": stage.stableAt ?? -1, "lastFrame": stage.lastFrame,
            "carryUntil": stage.carryUntil, "terminalSeatUntil": stage.terminalSeatUntil ?? -1]
        for (i, timer) in perch.runtime.timers.enumerated() { result["perch-" + String(i) + "-" + timer.action] = timer.at }
        for (i, timer) in stage.base.timers.enumerated() { result["base-" + String(i) + "-" + timer.action] = timer.at }
        return result.mapValues { $0.isFinite ? $0 : -1 }
    }
    var pendingMotion: PerchPlan?, motionMetrics: PerchMetrics?, motionArt: SpriteStagePose?
    var capture = "hidden", changing = false
    var characterHiddenControl = false
    var pacingSource = "character", pacingHz = 60, pacingDurationMs = 600
    var cadenceImages: [CGImage] = [], motionTiming: [String: Any] = [:]
    var activity = "startup", baseReadyMs: Double?, seedArrivalMs: Double?, firstInstallMs: Double?
    var shown: StageDraw?
    var installs = StageBenchInstalls(), planSeq = -1
    var pointerInputSeq = 0
    let screen: NSScreen
    init(ownerAwayFile: String?) {
        self.ownerAwayFile = ownerAwayFile
        screen = NSScreen.screens[0]
        host.perch.stage.trace = StageTrace()
        host.capture = "hidden"; host.cursorStyle = "sprite"; host.perch.enabled = true; host.perch.lines = false
        stageBenchLegacyWindowFrame = { [weak self] pid, id in
            guard pid == getpid(), let self = self, let panel = self.fixtures.first(where: { $0.windowNumber == id }) else { return nil }
            return ["appKitFrame": stageBenchRect(panel.frame), "topLeftFrame": stageBenchRect(self.top(panel.frame))]
        }
        // This fixture does not run HandHost.applicationDidFinishLaunching. Retain its pause delivery.
        host.pauseControl.changed = { [weak host] value in host?.pauseChanged(value) }
        stageBenchPlanned = { [weak self] seq, plan, metrics in
            self?.planSeq = seq; self?.installs.expect(stageBenchPlanID(seq, plan, metrics))
        }
        stageBenchInstalled = { [weak self] perch, plan, metrics, art, ms in
            guard let self = self else { return }
            self.installs.record(stageBenchPlanID(self.planSeq, plan, metrics), hostTimeMs: CACurrentMediaTime() * 1000, installMs: ms, cause: perch.stageBenchInstallCause)
            self.installTimes.append(ms)
            let draw = perch.stage.draw; self.shown = draw
            if self.firstInstallMs == nil { self.firstInstallMs = CACurrentMediaTime() * 1000 }
            if self.startup == nil, !perch.stageActive || art?.medium == false { self.startup = (CACurrentMediaTime() - self.received) * 1000 }
            let bounds = perch.panel.map { self.top($0.frame) } ?? .null
            let extent = plan.positions.reduce(CGRect.null) { $0.union(CGRect(origin: $1.1, size: metrics.size)) }
            let seat = draw?.seat.box ?? CGRect(origin: plan.positions.last?.1 ?? .zero, size: metrics.size)
            self.panels.append(["panel": stageBenchRect(bounds), "seat": stageBenchRect(seat), "move": stageBenchRect(extent),
                "drawing": perch.drawingGeometry?.json as Any? ?? NSNull()])
        }
        let visible = screen.visibleFrame, width = min(700, visible.width * 0.44), height = min(350, visible.height * 0.42)
        let background = StageBenchBackdropPanel(contentRect: visible, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        background.isReleasedWhenClosed = false; background.hasShadow = false; background.ignoresMouseEvents = true
        background.hidesOnDeactivate = false
        background.level = NSWindow.Level(rawValue: NSWindow.Level.normal.rawValue - 1)
        let backgroundView = NSView(frame: CGRect(origin: .zero, size: visible.size)); backgroundView.wantsLayer = true
        backgroundView.layer?.backgroundColor = CGColor(gray: 1, alpha: 1); background.contentView = backgroundView
        backdrop = background; content.append(backgroundView.layer!)
        for i in 0..<2 {
            let x = i == 0 ? visible.minX + 30 : visible.maxX - width - 30
            let panel = StageBenchBackdropPanel(contentRect: CGRect(x: x, y: visible.minY + 40, width: width, height: height),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
            panel.isReleasedWhenClosed = false; panel.level = .normal; panel.hidesOnDeactivate = false
            panel.hasShadow = false; panel.ignoresMouseEvents = true; panel.backgroundColor = .white
            let view = NSView(frame: CGRect(origin: .zero, size: panel.frame.size)); view.wantsLayer = true
            view.layer?.backgroundColor = CGColor(gray: 1, alpha: 1)
            panel.contentView = view; panel.orderFrontRegardless(); fixtures.append(panel); content.append(view.layer!)
        }
        // Check 3 needed a separate 220 x 122 person window. Own that stand-in here, and protect its observed bounds
        // through the ordinary stage world. It neither activates the app nor depends on the owner's frontmost app.
        let standIn = StageBenchBackdropPanel(contentRect: CGRect(x: visible.maxX - 240, y: visible.maxY - 142, width: 220, height: 122),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        standIn.isReleasedWhenClosed = false; standIn.hidesOnDeactivate = false; standIn.hasShadow = false
        standIn.ignoresMouseEvents = true
        standIn.level = .normal; standIn.backgroundColor = .white; standIn.title = "Person stand-in"
        standIn.setAccessibilityElement(false)
        standIn.orderFrontRegardless(); fixtures.forEach { $0.orderFrontRegardless() }; person = standIn
        stageBenchPersonWindow = StageWindowKey(pid: getpid(), window: UInt32(standIn.windowNumber))
        stageBenchFixtureWindowIDs = Set((fixtures + [standIn]).map { UInt32($0.windowNumber) })
        surface = StageBenchSurface(backdrop: background, targets: fixtures + [standIn],
            normal: NSWindow.Level.normal.rawValue, character: NSWindow.Level.floating.rawValue)
        surface?.didEnd = { [weak self] in
            self?.changing = false; self?.content.forEach { $0.removeAllAnimations() }
        }
        stageBenchInstallStops { [weak self] in self?.cleanup() }
        stageBenchJSON(["ready": true, "parkedReady": true, "machine": ["mac": stageBenchModel(),
            "macOS": ProcessInfo.processInfo.operatingSystemVersionString, "maximumHz": screen.maximumFramesPerSecond,
            "hostNice": getpriority(PRIO_PROCESS, 0)],
            "personWindow": ["id": standIn.windowNumber, "pid": getpid(), "bounds": rectObject(top(standIn.frame))],
            "windows": fixtures.map { ["id": $0.windowNumber, "pid": getpid(), "bounds": rectObject(top($0.frame))] }])
    }
    func top(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: (NSScreen.screens.first?.frame.maxY ?? 0) - r.maxY, width: r.width, height: r.height) }
    func rectObject(_ r: CGRect) -> [String: Double] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }
    func world(_ id: UInt32) -> StageWorld? {
        guard fixtures.contains(where: { $0.windowNumber == id }) else { return nil }
        return host.perch.stageEnvironment()
    }
    func snapshot() -> [String: Any] {
        shown = host.perch.stage.shown && host.perch.panel?.isVisible == true ? host.perch.stage.draw : nil
        var row: [String: Any] = ["stageArt": shown?.art?.medium == false,
            "panel": host.perch.panel.map { rectObject(top($0.frame)) } as Any? ?? NSNull(),
            "panelID": host.perch.panel?.windowNumber as Any? ?? NSNull(), "pid": getpid(),
            "fixtureIDs": fixtures.map { $0.windowNumber } + (person.map { [$0.windowNumber] } ?? []),
            "fixtureWindows": (fixtures + (person.map { [$0] } ?? [])).map {
                ["id": $0.windowNumber, "ignoresMouseEvents": $0.ignoresMouseEvents,
                    "canBecomeKey": $0.canBecomeKey, "canBecomeMain": $0.canBecomeMain] as [String: Any]
            },
            "backdrop": backdrop.map { ["id": $0.windowNumber, "bounds": rectObject(top($0.frame)), "level": $0.level.rawValue,
                "visible": $0.isVisible, "raised": surface?.raised == true, "ignoresMouseEvents": $0.ignoresMouseEvents,
                "canBecomeKey": $0.canBecomeKey, "canBecomeMain": $0.canBecomeMain] as [String: Any] } as Any? ?? NSNull(),
            "pointerTarget": shown.map { [$0.seat.box.midX, $0.seat.box.midY] } as Any? ?? NSNull(),
            "installMs": installTimes, "installsPerPlan": installs.perPlan, "planIDs": installs.ids,
            "doubleInstalls": installs.doubleInstalls, "installCauses": installs.causes,
            "unplannedInstalls": installs.unplanned, "panels": panels,
            "startupMs": startup as Any? ?? NSNull(), "firstStripDecoded": startup != nil,
            "fixtureWakeSources": surface?.wakeSources ?? [], "changing": changing, "activity": activity, "installCount": installTimes.count,
            "startupTimeline": ["characterReceivedMs": received * 1000, "baseReadyMs": baseReadyMs as Any? ?? NSNull(),
                "seedArrivalMs": seedArrivalMs as Any? ?? NSNull(), "firstInstallMs": firstInstallMs as Any? ?? NSNull(),
                "quietCompletedMs": host.perch.stageCall.quiet && host.perch.stageCall.sampled.isFinite ? host.perch.stageCall.sampled * 1000 as Any : NSNull()],
            "motionTiming": motionTiming, "pacingSource": pacingSource,
            "motionSource": "scripted renderer pacing, preflighted separate path", "hostTimeMs": CACurrentMediaTime() * 1000]
        row.merge(host.perch.diagnostics) { _, b in b }
        if let character = host.perch.loaded { row.merge(character.stage.counters) { _, b in b } }
        return row
    }
    func command(_ row: [String: Any]) {
        if let command = row["bench"] as? String {
            switch command {
            case "parkReady":
                let tree = stageBenchProcessTree(), pending = host.perch.loaded?.stage.counters["pending"] as? Int ?? 0
                stageBenchJSON(["reply": command, "ready": pending == 0 && (tree?["nonWorkerChildren"] as? Int) == 0,
                    "pending": pending, "processTree": tree as Any? ?? NSNull()]); return
            case "control":
                characterHiddenControl = true
                host.perch.enabled = false; host.perch.takeDown()
            case "tree":
                var status = host.perch.diagnostics
                status["parkedDecodePending"] = host.perch.loaded?.stage.counters["pending"] ?? 0
                status.merge(["reply": command, "pid": getpid(), "panelID": host.perch.panel?.windowNumber as Any? ?? NSNull(),
                    "hostTimeMs": CACurrentMediaTime() * 1000, "installCount": installTimes.count,
                    "processTree": stageBenchProcessTree() as Any? ?? NSNull()]) { _, b in b }
                stageBenchJSON(status); return
            case "statusCost":
                let cost = stageBenchReplyCost { self.command(["bench": "status"]) }
                stageBenchJSON(cost.merging(["reply": command]) { _, b in b }); return
            case "status":
                let cache = host.perch.loaded?.stage.counters ?? [:]
                let fields = ["pending", "decodes", "cacheBytes", "cacheHits", "cacheSelects"]
                var status = host.perch.diagnostics
                for key in fields { status[key] = cache[key] ?? 0 }
                status.merge(["reply": command, "pid": getpid(), "panelID": host.perch.panel?.windowNumber as Any? ?? NSNull(),
                    "stageArt": host.perch.stage.draw?.art?.medium == false, "activity": activity,
                    "installCount": installTimes.count, "hostTimeMs": CACurrentMediaTime() * 1000, "characterHiddenControl": characterHiddenControl,
                    "processTree": stageBenchProcessTree() as Any? ?? NSNull()]) { _, b in b }
                stageBenchJSON(status); return
            case "trace":
                stageBenchJSON(["reply": command, "trace": host.perch.stage.trace?.json as Any? ?? NSNull()]); return
            // BEGIN STAGE BENCH POINTER INPUT
            case "pointer":
                guard Set(row.keys) == ["bench", "inputID", "inputSeq", "position"],
                    let inputID = row["inputID"] as? String, inputID.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
                    let inputSeq = row["inputSeq"] as? NSNumber, CFGetTypeID(inputSeq) != CFBooleanGetTypeID(),
                    inputSeq.doubleValue.isFinite, inputSeq.doubleValue.rounded() == inputSeq.doubleValue,
                    inputSeq.doubleValue > Double(pointerInputSeq), inputSeq.doubleValue <= 9007199254740991,
                    let position = row["position"] as? [NSNumber], position.count == 2,
                    position.allSatisfy({ CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite && abs($0.doubleValue) <= 100000 }) else { exit(65) }
                guard host.perch.stageActive, host.perch.stage.pointerActive, !host.perch.stageLocked, !host.perch.stageSleeping,
                    host.perch.pointerWake == nil, stageBenchPointerObserved == nil else {
                    stageBenchJSON(["reply": command, "ok": false, "error": "pointer-input-unavailable", "pid": getpid()]); return
                }
                pointerInputSeq = inputSeq.intValue
                stageBenchPointerPosition = CGPoint(x: position[0].doubleValue, y: position[1].doubleValue)
                stageBenchPointerObserved = { effects, panelID, beforeBox, enteredAt in
                    stageBenchPointerObserved = nil
                    stageBenchPointerPosition = nil
                    let rows: [[String: Any]] = effects.compactMap { effect in
                        switch effect {
                        case let .hide(reason, duration):
                            return ["outcome": duration > 0 ? "fade" : "hidden", "reason": reason,
                                "durationMs": duration * 1000]
                        case let .draw(draw):
                            let duration = max(draw.pose.positions.last?.0 ?? 0, draw.pose.opacity.last?.0 ?? 0)
                            return ["outcome": beforeBox != draw.seat.box ? "move" : "fade",
                                "reason": draw.decisionReason as Any? ?? NSNull(), "inputSeq": inputSeq,
                                "durationMs": duration * 1000, "opacity": draw.pose.opacity.last?.1 as Any? ?? NSNull(),
                                "box": stageBenchRect(draw.seat.box)]
                        case .park, .reseat: return nil
                        }
                    }
                    stageBenchJSON(["reply": command, "source": "stage-pointer-input/1", "pid": getpid(),
                        "panelID": panelID as Any? ?? NSNull(), "inputID": inputID, "inputSeq": inputSeq, "position": position,
                        "inputHostMs": enteredAt * 1000, "completedHostMs": CACurrentMediaTime() * 1000, "effects": rows])
                }
                host.perch.stagePointerChanged(CACurrentMediaTime())
                return
            // END STAGE BENCH POINTER INPUT
            case "query": break
            case "captureFixture": fixtures[1].orderOut(nil)
            case "surface":
                guard let value = row["changing"] as? Bool else { exit(65) }; changing = value
                if value {
                    changing = surface?.begin(timeoutSeconds: stageBenchExposureSeconds(control: characterHiddenControl),
                        ownerAwayFile: ownerAwayFile) == true
                } else { surface?.end() }
                for layer in content {
                    layer.removeAllAnimations()
                    if changing {
                        let a = CABasicAnimation(keyPath: "backgroundColor"); a.fromValue = CGColor(gray: 1, alpha: 1); a.toValue = CGColor(gray: 0.7, alpha: 1)
                        a.duration = 1; a.autoreverses = true; a.repeatCount = .infinity; layer.add(a, forKey: "loop")
                    }
                }
            case "capture":
                guard let value = row["mode"] as? String, ["hidden", "visible"].contains(value) else { exit(65) }
                capture = value
            case "seat":
                runtime = host.perch.stage
                guard let seat = row["seat"] as? String, ["edge-lie", "front-sit"].contains(seat), let frame = runtime.base.frame,
                    let ev = runtime.event, let world = world(ev.window) else { exit(65) }
                // Use the runtime's own candidate generator with the explicit seat constraint for H5 only.
                runtime.options.frontSit = true; runtime.prepare(world)
                let art = host.perch.loaded?.stage.select(seat == "edge-lie" ? "stage-lie" : "stage-sit-notes", images: host.perch.loaded!.images)
                guard let found = runtime.locate(world, avoidingPointer: true, dodge: false, only: seat, art: art), frame.stage != nil else { exit(65) }
                let changes = runtime.install(found, now: CACurrentMediaTime(), reduced: true, faded: false, dodge: false)
                host.perch.stage = runtime; host.perch.performStage(changes)
                host.perch.wake?.cancel(); host.perch.wake = nil
                if capture == "visible" { host.perch.panel?.sharingType = .readOnly }
            case "park":
                activity = "parked"
                if host.perch.stageActive {
                    host.perch.performStage(host.perch.stage.setPaused(true, now: CACurrentMediaTime(), world: host.perch.stageEnvironment(), reduced: true))
                } else {
                    host.pauseControl.set(true)
                }
            case "hide": host.hide(); shown = nil
            case "prepare":
                let ms = row["durationMs"] as? Int ?? 0
                guard let hz = row["hz"] as? Int, [60, 120].contains(hz), [400, 600].contains(ms),
                    let source = row["source"] as? String, ["character", "numbered"].contains(source) else { exit(65) }
                pacingSource = source; pacingHz = hz; pacingDurationMs = ms; motionTiming = [:]
                cadenceImages = source == "numbered" ? stageBenchCadence(hz, ms) : []
                _ = snapshot()
                let draw = shown, legacy = host.perch.stageActive ? nil : host.perch.runtime.plan
                let metrics = draw?.metrics ?? (legacy == nil ? nil : host.perch.runtime.metrics)
                let box = draw?.seat.box ?? legacy.flatMap { p in metrics.map { CGRect(origin: p.positions.last?.1 ?? .zero, size: $0.size) } }
                let id = draw?.seat.window ?? legacy?.seat.window
                let world = id.flatMap { id in
                    host.perch.stageActive ? self.world(id) : perchWorld(pid: getpid(), window: id).map {
                        StageWorld(base: $0, usable: top(screen.visibleFrame), person: nil, pointer: CGPoint(x: -10000, y: -10000), inputAge: 20, pointerAway: 20)
                    }
                }
                runtime = host.perch.stage
                if let world = world { runtime.prepare(world) }
                let motion = stageBenchMotion(box: box, usable: top(screen.visibleFrame), target: world?.base.window, durationMs: ms) { swept in
                    guard let world = world else { return false }
                    if host.perch.stageActive { return runtime.clear(swept, world, pointer: 100) }
                    return world.usable.contains(swept) && world.base.above.allSatisfy { !$0.intersects(swept) }
                }
                guard motion.reason == nil, var pose = draw?.pose ?? legacy, let metrics = metrics else {
                    pendingMotion = nil
                    stageBenchJSON(snapshot().merging(motion.json) { _, b in b }.merging(["reply": command]) { _, b in b }); return
                }
                host.perch.wake?.cancel(); host.perch.wake = nil
                host.ringWake?.cancel(); host.ringWake = nil
                let duration = Double(ms) / 1000
                pose.positions = motion.positions; pose.opacity = [(0, 1)]; pose.duration = max(pose.duration, duration)
                pendingMotion = pose; motionMetrics = metrics; motionArt = draw?.art
                // Hold the same full motion panel while SCK warms, so its dimensions and origin stay fixed.
                var parked = pose; parked.cells = Array(parked.cells.prefix(1))
                stageBenchPlanned?(planSeq, parked, metrics)
                host.perch.install(parked, stageMetrics: metrics, stagePose: draw?.art)
                host.perch.boxLayer?.removeAllAnimations()
                // Preserve the first sample's real layer position in the fixed motion panel.
                if let first = pose.positions.first { host.perch.boxLayer?.position = CGPoint(x: first.1.x - host.perch.frame.minX, y: first.1.y - host.perch.frame.minY) }
                if pacingSource == "numbered", let layer = host.perch.boxLayer {
                    stageBenchStationary(layer, image: cadenceImages.last!, position: layer.position)
                }
                host.perch.panel?.sharingType = .readOnly
                stageBenchJSON(snapshot().merging(motion.json) { _, b in b }.merging(["reply": command]) { _, b in b }); return
            case "start":
                guard let plan = pendingMotion, let metrics = motionMetrics else { exit(65) }
                guard let start = row["startAtHostMs"] as? Double, start > CACurrentMediaTime() * 1000, start < CACurrentMediaTime() * 1000 + 2000 else { exit(65) }
                stageBenchScheduledStart = start / 1000
                defer { stageBenchScheduledStart = nil }
                stageBenchQuiesce(host)
                do { self.motionTiming = try stageBenchScheduledInstall(start, timers: { self.motionTimers }, install: {
                    stageBenchPlanned?(self.planSeq, plan, metrics)
                    self.host.perch.install(plan, stageMetrics: metrics, stagePose: self.motionArt)
                    return self.host.perch.boxLayer
                }, control: { layer, begin in
                    let installed = try stageBenchInstallCadence(source: self.pacingSource, layer: layer, images: self.cadenceImages,
                        hz: self.pacingHz, durationMs: self.pacingDurationMs, begin: begin, position: plan.positions.first.map {
                            CGPoint(x: $0.1.x - self.host.perch.frame.minX, y: $0.1.y - self.host.perch.frame.minY) })
                    self.host.perch.panel?.sharingType = .readOnly
                    return installed
                }) } catch {
                    stageBenchJSON(stageBenchScheduleFailure(error, source: self.pacingSource,
                        timers: self.motionTimers, layer: self.host.perch.boxLayer)); return
                }
                self.motionTiming.merge(["source": self.pacingSource, "requestedHz": self.pacingHz,
                    "durationMs": self.pacingDurationMs, "numberedFrames": self.cadenceImages.count]) { _, b in b }
            default: exit(65)
            }
            stageBenchJSON(snapshot().merging(["reply": command]) { _, b in b }); return
        }
        guard let hand = handFrame(row), let key = row["nonce"] as? String, nonce == nil || nonce == key else { exit(65) }; nonce = key
        switch hand {
        case let .character(_, frame):
            guard frame.seq > last else { exit(65) }; last = frame.seq; received = CACurrentMediaTime()
            host.spriteLoader.start(frame) { _, result in
                DispatchQueue.main.async {
                    guard let character = result.character else { exit(65) }
                    self.baseReadyMs = CACurrentMediaTime() * 1000
                    self.host.perch.configure(character: character, replace: true)
                    for name in ["stage-lie", "stage-lie-reach", "stage-lie-peek", "stage-sleep"] { _ = character.stage.select(name, images: character.images) }
                    SpriteLoader.queue.async { DispatchQueue.main.async { stageBenchJSON(["characterReady": true]) } }
                }
            }
        case let .aim(_, ev), let .status(_, ev):
            guard ev.seq > last, let at = ev.at else { exit(65) }; last = ev.seq
            if seedArrivalMs == nil { seedArrivalMs = CACurrentMediaTime() * 1000; activity = "animate" }
            // Direct ring dispatch skips receiveCursor's saved pause target.
            // Keep that ingress state so the legacy pause path can rebuild its pose.
            host.pauseTarget = ev
            _ = at; host.ringFrame(ev, delay: 0)
        case let .act(_, act):
            guard act.seq > last else { exit(65) }; last = act.seq
            host.pauseTarget = ringEvent(act)
            host.ringFrame(ringEvent(act), delay: act.delay)
        case .hide: host.hide(); shown = nil
        default: exit(65)
        }
    }
    func cleanup() {
        guard !closed else { return }; closed = true
        surface?.end(); changing = false
        host.hide(); fixtures.forEach { $0.close() }; person?.close(); backdrop?.close()
        stageBenchPersonWindow = nil; stageBenchInstalled = nil; stageBenchPlanned = nil; stageBenchFixtureWindowIDs = []
    }
    func close() { cleanup(); NSApp.stop(nil); exit(0) }
}

func stageBenchMain(_ args: [String]) {
    if args == ["--trace-self-test"] {
        let trace = StageTrace(limit: 512)
        trace.append(["op": "complete", "now": 2], ["turnTargets": 0, "shown": false])
        let before = trace.rows.count
        trace.append(["op": "windows", "payload": String(repeating: "x", count: 1024)])
        trace.append(["op": "complete", "now": 3])
        let windows = Dictionary(uniqueKeysWithValues: (1...129).map {
            (StageWindowKey(pid: 42, window: UInt32($0)), CGRect(x: 100, y: 600, width: 500, height: 250))
        })
        var book = StageWindowBook(); book.observe(windows)
        var runtime = StageRuntime()
        runtime.event = PerchEvent(state: "aim", pid: 42, window: 1, at: CGPoint(x: 350, y: 800), ok: false, drop: nil, end: nil)
        let overflowWorld = StageWorld(base: PerchWorld(window: windows[StageWindowKey(pid: 42, window: 1)]!, above: [],
            display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30, fullScreen: false),
            usable: CGRect(x: 0, y: 30, width: 1800, height: 1140), person: CGRect(x: 1600, y: 1000, width: 100, height: 100),
            pointer: CGPoint(x: 1790, y: 1190), inputAge: 20, pointerAway: 10, windows: windows)
        _ = runtime.observe(0, world: overflowWorld, reduced: true)
        let worldTrace = StageTrace(); worldTrace.append(["op": "windows", "windows": stageTraceWindows(windows)])
        stageBenchJSON(["recordsBeforeOverflow": before, "recordsAfterOverflow": trace.rows.count,
            "complete": !trace.overflow, "bytes": trace.bytes, "limit": trace.limit,
            "windowRecords": book.current.count, "windowOverflow": book.overflow, "oversizedWorldComplete": !worldTrace.overflow,
            "capacityHide": runtime.hiddenReason == "target-capacity", "overflowShown": runtime.shown,
            "windowsCreated": 0, "captures": 0]); return
    }
    if args == ["--motion-dump"] {
        func rect(_ raw: Any?) -> CGRect? {
            guard let a = raw as? [Double], a.count == 4, a.allSatisfy({ $0.isFinite && abs($0) <= 100000 }), a[2] > 0, a[3] > 0 else { return nil }
            return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
        }
        while let line = readLine() {
            guard line.utf8.count <= 32768, let data = line.data(using: .utf8),
                let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let usable = rect(row["usable"]) else { exit(65) }
            let forbidden = (row["forbidden"] as? [Any] ?? []).compactMap(rect)
            let result = stageBenchMotion(box: rect(row["box"]), usable: usable, target: rect(row["target"]),
                durationMs: row["durationMs"] as? Int ?? 0, legacy: row["legacy"] as? Bool == true) { box in
                    usable.contains(box) && forbidden.allSatisfy { !$0.intersects(box) }
                }
            stageBenchJSON(result.json.merging(["windowsCreated": 0, "captures": 0]) { _, b in b })
        }
        return
    }
    if args == ["--cadence-self-test"] {
        let rows: [[String: Any]] = [60, 120].flatMap { hz in [400, 600].map { ms in
            let images = stageBenchCadence(hz, ms), track = stageBenchCadenceTrack(images, durationMs: ms, begin: 123.5)
            let hashes = images.map { image -> String in
                guard let bytes = image.dataProvider?.data else { exit(70) }
                return SHA256.hash(data: bytes as Data).map { String(format: "%02x", $0) }.joined()
            }
            return ["hz": hz, "durationMs": ms, "count": images.count, "unique": Set(hashes).count,
                "keyTimes": track.keyTimes!, "begin": track.beginTime, "duration": track.duration,
                "discrete": track.calculationMode == .discrete, "fillMode": track.fillMode.rawValue]
        } }
        let root = CALayer(), layer = CALayer(), position = CABasicAnimation(keyPath: "position")
        root.addSublayer(layer)
        for name in ["session-badge", "honest-mood"] {
            let sibling = CALayer(); sibling.name = name
            sibling.add(CABasicAnimation(keyPath: "position"), forKey: "position"); root.addSublayer(sibling)
        }
        layer.addSublayer(CALayer())
        for key in ["transform", "opacity", "contentsRect"] { layer.add(CABasicAnimation(keyPath: key), forKey: key) }
        layer.opacity = 0.35
        position.beginTime = 1.0585; layer.add(position, forKey: "position")
        var ticks = [1058.0, 1059.0, 1060.0], called = 0
        guard let timing = try? stageBenchMeasuredInstall(1000, clock: { ticks.removeFirst() }, install: { called += 1; return layer }, control: { layer, begin in
            try stageBenchInstallCadence(source: "numbered", layer: layer, images: stageBenchCadence(60, 600), hz: 60,
                durationMs: 600, begin: begin, position: CGPoint(x: 12, y: 34))
        }) else { exit(70) }
        // A faulty control can claim success while leaving a motion animation. The receipt must expose it.
        let badRoot = CALayer(), badLayer = CALayer()
        badRoot.addSublayer(badLayer)
        let badTiming = stageBenchMeasuredInstall(1000, install: { return badLayer }, control: { layer, _ in
            let receipt = try! stageBenchInstallCadence(source: "numbered", layer: layer, images: stageBenchCadence(60, 600),
                hz: 60, durationMs: 600, begin: 1, position: CGPoint(x: 12, y: 34))
            layer!.add(CABasicAnimation(keyPath: "opacity"), forKey: "opacity")
            return receipt
        })
        stageBenchJSON(["rows": rows, "scheduleFailures": stageBenchScheduleFailures(), "timing": timing, "installCalls": called, "controlBegin": layer.animation(forKey: "contents")!.beginTime,
            "badTiming": badTiming,
            "stationary": layer.animation(forKey: "position") == nil, "position": [layer.position.x, layer.position.y],
            "animationKeys": layer.animationKeys() ?? [], "opacity": layer.opacity,
            "siblings": (root.sublayers?.count ?? 0) - 1, "children": layer.sublayers?.count ?? 0,
            "windowsCreated": 0, "captures": 0]); return
    }
    if args == ["--cadence-invalid-self-test"] {
        let images = stageBenchCadence(60, 600), layer = CALayer(), point = CGPoint(x: 12, y: 34)
        let cases: [(CALayer?, Double?, CGPoint?, [CGImage])] = [
            (nil, 1, point, images), (layer, nil, point, images), (layer, 1, nil, images),
            (layer, 1, point, []), (layer, 1, point, Array(images.dropLast()))]
        var errors = 0
        for (candidate, begin, position, art) in cases {
            do { _ = try stageBenchInstallCadence(source: "numbered", layer: candidate, images: art, hz: 60, durationMs: 600,
                begin: begin, position: position) } catch { errors += 1 }
        }
        stageBenchJSON(["errors": errors, "cases": cases.count, "windowsCreated": 0, "captures": 0]); return
    }
    if args == ["--diagnostics-self-test"] {
        let monitor = StageCallMonitor()
        monitor.pending = true; monitor.requested = 10
        let pending = monitor.snapshot(12)
        monitor.pending = false; monitor.quiet = true; monitor.sampleState = "quiet"; monitor.sampled = 12
        let quiet = monitor.snapshot(12.5), stale = monitor.snapshot(14)
        monitor.quiet = false; monitor.sampleState = "input-active"; monitor.sampled = 14
        let active = monitor.snapshot(14)
        monitor.sampleState = "unavailable"
        let unavailable = monitor.snapshot(14)
        let small = stageVisibilityStatus(stagePath: false, stageShown: false, legacyShown: true, panelVisible: true, rung: nil, reason: nil)
        let hidden = stageVisibilityStatus(stagePath: false, stageShown: true, legacyShown: true, panelVisible: false, rung: "stage", reason: "hide")
        stageBenchJSON(["callStates": [pending, quiet, stale, active, unavailable], "small": small, "hidden": hidden,
            "windowsCreated": 0, "captures": 0]); return
    }
    if args == ["--telemetry-self-test"] {
        var installs = StageBenchInstalls()
        for id in ["once", "missing", "twice"] { installs.expect(id) }
        for (index, id) in ["once", "twice", "twice", "orphan"].enumerated() { installs.record(id, hostTimeMs: Double(999 + index), installMs: 0.5) }
        let seat = PerchSeat(pid: 42, window: 7, x: 400, edge: 500, peek: false, rise: 75,
            frame: CGRect(x: 200, y: 500, width: 900, height: 350), display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30)
        let plan = PerchPlan(kind: "stay", seat: seat), metrics = PerchMetrics(size: CGSize(width: 96, height: 104), anchor: CGPoint(x: 48, y: 75), scale: 0.5, legs: (0, 0))
        var sequence = StageBenchPlanSequence(), legacy = StageBenchInstalls()
        for _ in 0..<2 {
            let next = PerchPlan(kind: plan.kind, seat: seat)
            let id = stageBenchPlanID(sequence.next(next), next, metrics); legacy.expect(id); legacy.record(id)
        }
        stageBenchJSON(["installsPerPlan": installs.perPlan, "unplannedInstalls": installs.unplanned,
            "doubleInstalls": installs.doubleInstalls, "installCauses": installs.causes, "legacy": ["planIDs": legacy.ids, "installsPerPlan": legacy.perPlan],
            "windowsCreated": 0, "captures": 0, "mac": stageBenchModel()]); return
    }
    if args == ["--self-test"] {
        stageBenchJSON(["ok": true, "windowsCreated": 0, "captures": 0, "fixtureWindows": 4, "productionRenderer": true]); return
    }
    guard stageBenchArgumentsValid(args) else { exit(64) }
    let app = NSApplication.shared; app.setActivationPolicy(.prohibited)
    let fixture = StageBench(ownerAwayFile: args.count == 3 ? args[2] : nil)
    DispatchQueue.global().async {
        while let line = readLine() {
            guard line.utf8.count <= 32768, let bytes = line.data(using: .utf8), let row = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { exit(65) }
            DispatchQueue.main.sync { fixture.command(row) }
        }
        DispatchQueue.main.async { fixture.close() }
    }
    app.run()
}
