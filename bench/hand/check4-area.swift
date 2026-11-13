// Metadata-only fixture guard. Owns exactly the apps it hides until EOF or an interrupt.
// It never reads window titles or contents, sends Apple events, quits apps or creates windows.
import AppKit
import CoreGraphics
import Foundation
import Darwin

let fixtureBundles: Set<String> = ["com.apple.TextEdit", "com.apple.Preview", "com.apple.finder", "com.apple.calculator"]
struct AreaApp {
    let pid: Int32, bundle: String, birth: Double
    let hidden: () -> Bool, alive: () -> Bool, hide: () -> Bool, unhide: () -> Bool
    var identity: [String: Any] { ["pid": pid, "bundle": bundle, "birth": birth] }
}
func areaSettle(_ condition: () -> Bool) -> Bool {
    let until = Date().addingTimeInterval(2)
    // AppKit caches running-application properties until the next main run-loop turn.
    repeat {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
        if condition() { return true }
    } while Date() < until
    return condition()
}
final class AreaGuard {
    var owned: [AreaApp] = []
    let settle: (() -> Bool) -> Bool
    init(settle: @escaping (() -> Bool) -> Bool = areaSettle) { self.settle = settle }
    func hide(_ apps: [AreaApp]) throws {
        _ = settle { true }
        for app in apps where !fixtureBundles.contains(app.bundle) && !app.hidden() {
            // Own restoration before invoking hide, including a partial or failed hide.
            owned.append(app)
            let alive = app.alive(), sent = alive && app.hide()
            // Delivery and hidden state are observed after a run-loop turn, including a false return.
            let hidden = settle { !app.alive() || app.hidden() }
            guard alive, app.alive(), hidden, app.hidden() else {
                throw NSError(domain: "fixture-area-hide", code: 1, userInfo: ["pid": app.pid, "alive": alive, "sent": sent, "hidden": app.hidden()])
            }
        }
    }
    func restore() -> Bool {
        _ = settle { true }
        for app in owned.reversed() where app.alive() {
            if app.hidden() { _ = app.unhide() }
        }
        return settle { !self.owned.contains(where: { $0.alive() && $0.hidden() }) }
    }
}
func emit(_ row: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(bytes + Data([10]))
}
// System surfaces this guard cannot hide. Their banners are interruptions to wait out: never hidden, clicked or signalled here.
let systemOwners: Set<String> = ["com.apple.notificationcenterui", "com.apple.UserNotificationCenter",
    "Notification Center", "NotificationCenter", "UserNotificationCenter"]
struct AreaOwner { let prohibited: Bool, birth: Double?, bundle: String? }
enum AreaCover { case none, app, system, unidentified }
func areaClassify(layer: Int, ownerName: String?, owner: AreaOwner?) -> AreaCover {
    let known = [owner?.bundle, ownerName].contains { $0.map(systemOwners.contains) == true }
    if known { return .system }
    // WindowServer's pointer and the system's display surfaces are not applications to hide.
    guard let owner = owner, !owner.prohibited else { return layer == 0 ? .unidentified : .none }
    // An app launchd started has no launch date to check on restore. Above layer 0 it is a system banner.
    guard owner.birth != nil, let bundle = owner.bundle else { return layer == 0 ? .unidentified : .system }
    return fixtureBundles.contains(bundle) ? .none : .app
}
// Poll about every 2 s until no system window covers the area, with one row per minute, and refuse at the deadline.
func areaWaitSystem(_ system: () throws -> [[String: Any]], deadline: Date, now: () -> Date = Date.init,
    sleep: (Double) -> Void = { RunLoop.current.run(until: Date(timeIntervalSinceNow: $0)) },
    report: ([String: Any]) -> Void = emit) throws -> Double {
    let began = now(); var reported: Double? = nil
    while true {
        let found = try system(), waited = now().timeIntervalSince(began)
        if found.isEmpty { return waited }
        if now() >= deadline {
            throw NSError(domain: "fixture-area-system-window-timeout", code: 1, userInfo: ["waitedS": Int(waited), "windows": found])
        }
        if reported.map({ waited - $0 >= 60 }) ?? true {
            reported = waited; report(["phase": "waiting", "reason": "system-window", "waitedS": Int(waited), "windows": found])
        }
        sleep(2)
    }
}
func areaRunMainLoop() {
    let keepAlive = Timer(timeInterval: 60, repeats: true) { _ in }
    RunLoop.main.add(keepAlive, forMode: .common)
    CFRunLoopRun()
    keepAlive.invalidate()
}
let args = Array(CommandLine.arguments.dropFirst())
if args == ["--selftest"] {
    // Run the real ownership logic against fake applications. No host metadata or app calls.
    var states = [1: false, 2: false, 3: true, 4: false], hidden: [Int] = [], unhidden: [Int] = []
    func fake(_ pid: Int, _ bundle: String, fail: Bool = false) -> AreaApp {
        AreaApp(pid: Int32(pid), bundle: bundle, birth: 1, hidden: { states[pid]! }, alive: { true },
            hide: { hidden.append(pid); states[pid] = !fail; return !fail },
            unhide: { unhidden.append(pid); states[pid] = false; return true })
    }
    let guarder = AreaGuard(settle: { condition in condition() })
    var failed = false
    do { try guarder.hide([fake(1, "com.apple.TextEdit"), fake(2, "fixture.cover"), fake(3, "already.hidden"), fake(4, "failed.cover", fail: true)]) }
    catch { failed = true }
    let restored = guarder.restore()
    // A false return can precede AppKit's asynchronous hide. Observe the state before deciding.
    var asynchronousHidden = false, deferredHide = false
    let asynchronous = AreaGuard(settle: { condition in if deferredHide { asynchronousHidden = true; deferredHide = false }; return condition() })
    let asyncApp = AreaApp(pid: 5, bundle: "deferred.cover", birth: 1, hidden: { asynchronousHidden }, alive: { true },
        hide: { deferredHide = true; return false }, unhide: { asynchronousHidden = false; return true })
    try! asynchronous.hide([asyncApp]); let asyncRestored = asynchronous.restore()
    var mainQueueRestored = false
    DispatchQueue.main.async {
        mainQueueRestored = Thread.isMainThread && asynchronous.restore()
        CFRunLoopStop(CFRunLoopGetMain())
    }
    areaRunMainLoop()
    emit(["failed": failed, "restored": restored, "hidden": hidden, "unhidden": unhidden,
        "asyncRestored": asyncRestored && !asynchronousHidden,
        "mainQueueRestored": mainQueueRestored,
        "fixtureHidden": states[1]!, "previouslyHidden": states[3]!, "owned": guarder.owned.map { $0.pid }, "windowsCreated": 0])
    exit(0)
}
if args == ["--selftest-system"] {
    // Classify fake window owners and wait out a fake banner on a fake clock. No host metadata or app calls.
    let launchd = AreaOwner(prohibited: false, birth: nil, bundle: "com.apple.notificationcenterui")
    let classes: [String: AreaCover] = [
        "banner": areaClassify(layer: 21, ownerName: "Notification Center", owner: launchd),
        "bannerLayer0": areaClassify(layer: 0, ownerName: "Notification Center", owner: launchd),
        "launchdAgent": areaClassify(layer: 3, ownerName: "agent", owner: AreaOwner(prohibited: false, birth: nil, bundle: "x.agent")),
        "unidentified": areaClassify(layer: 0, ownerName: "agent", owner: AreaOwner(prohibited: false, birth: nil, bundle: "x.agent")),
        "noApp": areaClassify(layer: 0, ownerName: nil, owner: nil),
        "pointer": areaClassify(layer: 2000, ownerName: "Window Server", owner: AreaOwner(prohibited: true, birth: nil, bundle: nil)),
        "app": areaClassify(layer: 0, ownerName: "Notes", owner: AreaOwner(prohibited: false, birth: 1, bundle: "com.apple.Notes")),
        "fixture": areaClassify(layer: 0, ownerName: "TextEdit", owner: AreaOwner(prohibited: false, birth: 1, bundle: "com.apple.TextEdit"))]
    let names: [AreaCover: String] = [.none: "none", .app: "app", .system: "system", .unidentified: "unidentified"]
    var clock = Date(timeIntervalSince1970: 0), polls = 0, rows: [[String: Any]] = []
    let banner = [["owner": "Notification Center", "layer": 21]]
    func run(clearAfter: Int, limit: Double) -> Any {
        polls = 0; rows = []; let start = clock
        do {
            return try areaWaitSystem({ polls += 1; return polls > clearAfter ? [] : banner }, deadline: start.addingTimeInterval(limit),
                now: { clock }, sleep: { clock.addTimeInterval($0) }, report: { rows.append($0) })
        } catch { return (error as NSError).domain }
    }
    let cleared = run(clearAfter: 330, limit: 1200), clearedRows = rows.count, clearedPolls = polls
    let timedOut = run(clearAfter: Int.max, limit: 1200), timeoutRows = rows.count
    emit(["classes": classes.mapValues { names[$0]! }, "clearedWaitS": cleared, "clearedRows": clearedRows, "clearedPolls": clearedPolls,
        "timeout": timedOut, "timeoutRows": timeoutRows, "firstRow": rows.first?["phase"] ?? NSNull()])
    exit(0)
}
if args == ["--restore-apps"] {
    // Recovery accepts only identities already recorded by this guard. The owning Node script checks the bank.
    guard let rows = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [[String: Any]], rows.count <= 64 else { exit(65) }
    let guarder = AreaGuard()
    for row in rows {
        guard let pid = row["pid"] as? Int32, pid > 0, let bundle = row["bundle"] as? String,
              !fixtureBundles.contains(bundle), let birth = row["birth"] as? Double, birth.isFinite else { exit(65) }
        guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
        guard app.bundleIdentifier == bundle, let currentBirth = app.launchDate?.timeIntervalSince1970,
              abs(currentBirth - birth) < 0.001 else { emit(["restored": false, "reason": "identity-changed", "pid": pid]); exit(1) }
        guarder.owned.append(AreaApp(pid: pid, bundle: bundle, birth: birth, hidden: { app.isHidden },
            alive: { !app.isTerminated }, hide: { false }, unhide: { app.unhide() }))
    }
    let restored = guarder.restore()
    emit(["restored": restored, "mainThread": Thread.isMainThread, "apps": guarder.owned.map { $0.identity }]); exit(restored ? 0 : 1)
}
guard args == ["--guard"] else { exit(64) }
// Every stage seat and the fixture windows lie in the display's usable area. Cover all possible seats,
// including window sides and both screen edges, without predicting a seat from a previous task.
let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
let areas = NSScreen.screens.map { screen -> CGRect in
    let r = screen.visibleFrame
    return CGRect(x: r.minX, y: primaryTop - r.maxY, width: r.width, height: r.height)
}
func scan() throws -> (apps: [AreaApp], system: [[String: Any]]) {
    guard !areas.isEmpty, let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw NSError(domain: "fixture-area-metadata", code: 1)
    }
    var apps: [Int32: AreaApp] = [:], system: [[String: Any]] = []
    for window in windows {
        guard (window[kCGWindowAlpha as String] as? Double ?? 1) > 0,
              let pid = window[kCGWindowOwnerPID as String] as? Int32, pid != getpid(),
              let raw = window[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw), areas.contains(where: { $0.intersects(bounds) }) else { continue }
        let app = NSRunningApplication(processIdentifier: pid), layer = window[kCGWindowLayer as String] as? Int ?? 0
        let ownerName = window[kCGWindowOwnerName as String] as? String
        let owner = app.map { AreaOwner(prohibited: $0.activationPolicy == .prohibited, birth: $0.launchDate?.timeIntervalSince1970, bundle: $0.bundleIdentifier) }
        switch areaClassify(layer: layer, ownerName: ownerName, owner: owner) {
        case .none: continue
        case .unidentified: throw NSError(domain: "fixture-area-app-identity", code: Int(pid))
        case .system: system.append(["pid": pid, "owner": ownerName ?? "", "bundle": owner?.bundle ?? "", "layer": layer])
        case .app:
            guard let app = app, let birth = owner?.birth, let bundle = owner?.bundle else { continue }
            apps[pid] = AreaApp(pid: pid, bundle: bundle, birth: birth, hidden: { app.isHidden },
                alive: { !app.isTerminated && NSRunningApplication(processIdentifier: pid).map { app.isEqual($0) } == true },
                hide: { app.hide() }, unhide: { app.unhide() })
        }
    }
    return (apps.values.sorted { $0.pid < $1.pid }, system)
}
func covers() throws -> [AreaApp] { try scan().apps }
let guarder = AreaGuard()
var finished = false
func finish(_ code: Int32) {
    guard !finished else { return }; finished = true
    let restored = guarder.restore()
    emit(["phase": "restored", "restored": restored, "mainThread": Thread.isMainThread, "apps": guarder.owned.map { $0.identity }])
    exit(restored ? code : 1)
}
var signals: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { finish(1) }; source.resume(); signals.append(source)
}
do {
    guard NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.calculator").isEmpty else {
        throw NSError(domain: "fixture-area-calculator-must-be-closed", code: 1)
    }
    // A banner is waited out before hiding. One that arrives while hiding restores what this round hid and waits again.
    let deadline = Date().addingTimeInterval(1200)
    var systemWaitS = 0.0
    while true {
        systemWaitS += try areaWaitSystem({ try scan().system }, deadline: deadline)
        try guarder.hide(covers())
        let until = Date().addingTimeInterval(2)
        while Date() < until {
            if try covers().isEmpty { break }
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.02))
        }
        guard try covers().isEmpty else { throw NSError(domain: "fixture-area-still-covered", code: 1) }
        if try scan().system.isEmpty { break }
        guard guarder.restore() else { throw NSError(domain: "fixture-area-restore", code: 1) }
        guarder.owned.removeAll()
    }
    emit(["phase": "ready", "clear": true, "mainThread": Thread.isMainThread, "systemWaitS": Int(systemWaitS), "apps": guarder.owned.map { $0.identity },
        "areas": areas.map { [$0.minX, $0.minY, $0.width, $0.height] }])
} catch {
    emit(["phase": "refused", "reason": (error as NSError).domain, "detail": (error as NSError).userInfo])
    finish(1)
}
FileHandle.standardInput.readabilityHandler = { handle in
    // EOF releases the guard. Any unexpected input stops it and restores too.
    let bytes = handle.availableData
    handle.readabilityHandler = nil
    DispatchQueue.main.async { finish(bytes.isEmpty ? 0 : 65) }
}
// Keep AppKit's original main run loop alive. dispatchMain can service its queue on another thread,
// leaving NSRunningApplication's main-run-loop state stale during the EOF restoration callback.
areaRunMainLoop()
