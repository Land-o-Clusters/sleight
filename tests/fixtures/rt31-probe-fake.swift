import Foundation
import AppKit
import ApplicationServices
import Darwin

// Runs the production ProbeSystem and prepared CGEvent path with host reads and
// the final post replaced. Constructing these events never dispatches them.
final class FakeSystem {
    var time = 0.0, idle = 3000.0, active = false, blocked = false, secure = false, held = false, startUnavailable = false
    var startReads = 0, fullReadsWhileHeld = 0, holdChecks = 0
    var geometryReads = 0, geometryReadsWhileHeld = 0, geometryUnavailable = false
    var geometryDelayWhileHeld = 0.0
    var geometryReadsAtPost: [Int] = []
    var inputHeld = false
    var modifiers: CGEventFlags = []
    var destinationPids: [Int32] = [], posts: [String] = [], uiChecks = 0
    var postedPoints: [CGPoint] = []
    var geometry = ProbeAXGeometry(window: CGRect(x: 10, y: 20, width: 600, height: 400),
        toolbar: CGRect(x: 10, y: 52, width: 600, height: 48), content: CGRect(x: 10, y: 100, width: 600, height: 320))
    var afterPost: ((String) -> Void)?
    var failPost: Int?
    var afterGeometry: (() -> Void)?
    var afterUICheck: (() -> Void)?
    var process = ProbeProcessIdentity(pid: 321, bundle: "com.utmapp.UTM", start: ProbeStartTime(seconds: 100, microseconds: 0), executable: URL(fileURLWithPath: "/Applications/UTM.app/Contents/MacOS/UTM"))
    var host = ProbeHostSnapshot(pid: 999, start: ProbeStartTime(seconds: 200, microseconds: 0), window: nil, pointer: CGPoint(x: 10, y: 20))
    var rows: [[String: Any]] = [["kCGWindowOwnerPID": 321, "kCGWindowLayer": 0, "kCGWindowNumber": 654,
        "kCGWindowName": "fixture", "kCGWindowBounds": ["X": 10, "Y": 20, "Width": 600, "Height": 400]]]
    var services: ProbeServices {
        ProbeServices(now: { self.time }, pause: { self.time += $0 }, accessibility: { true },
            process: { _ in if self.inputHeld { self.fullReadsWhileHeld += 1 }; return self.process },
            startTime: { _ in
                self.startReads += 1
                if self.startUnavailable { throw ProbeFault("PROCESS_IDENTITY_UNAVAILABLE") }
                return self.process.start
            }, noHold: {
                self.holdChecks += 1
                if self.held { throw ProbeFault("TIMED_WINDOW_HOLD") }
            }, window: { try probeSelectWindow(self.rows, $0) }, geometry: { _ in
                self.geometryReads += 1
                if self.inputHeld { self.geometryReadsWhileHeld += 1; self.time += self.geometryDelayWhileHeld }
                if self.geometryUnavailable { throw ProbeFault("WINDOW_UNAVAILABLE") }
                self.afterGeometry?()
                return self.geometry
            },
            noBlockingUI: { _ in
                self.uiChecks += 1
                if self.blocked { throw ProbeFault("WINDOW_BLOCKED") }
                self.afterUICheck?()
                return ["axWindowCount": 1, "sheetCount": 0, "childCount": 2, "blockingChildCount": 0, "modalCount": 0]
            }, host: { self.host }, idleMs: { self.idle + self.time * 1000 },
            secureInput: { self.secure }, modifiers: { self.modifiers }, belief: { _ in self.active },
            sendToPid: { event, pid in
                guard let back = NSEvent(cgEvent: event) else { throw ProbeFault("EVENT_CONSTRUCTION_FAILED") }
                let name: String
                if back.type == .appKitDefined {
                    name = back.subtype == .applicationActivated ? "applicationActivated" : "applicationDeactivated"
                    self.active = back.subtype == .applicationActivated
                } else if back.type == .keyDown || back.type == .keyUp {
                    name = (back.type == .keyDown ? "keyDown-" : "keyUp-") + String(back.keyCode)
                } else {
                    name = back.type == .mouseMoved ? "mouseMoved" : back.type == .leftMouseDown ? "leftMouseDown" : "leftMouseUp"
                }
                self.destinationPids.append(pid); self.posts.append(name)
                self.geometryReadsAtPost.append(self.geometryReads)
                if back.type == .keyDown || back.type == .leftMouseDown { self.inputHeld = true }
                if back.type == .keyUp || back.type == .leftMouseUp { self.inputHeld = false }
                if back.type == .mouseMoved || back.type == .leftMouseDown || back.type == .leftMouseUp { self.postedPoints.append(event.location) }
                self.afterPost?(name)
                if self.posts.count == self.failPost { throw ProbeFault("POST_FAILED") }
            })
    }
}

final class FakeProbe {
    var time = 0.0, posts: [String] = [], checks = 0, identities = 0
    var inputHeld = false, checkedWhileHeld = false, pauseCount = 0, fullIdentitiesWhileHeld = 0, startReads = 0
    var failPost: Int?, failCheck: Int?, loseIdentityAfter: Int?, interruptAt: Double?
    var beliefTimeout = false, beliefStuck = false, postDelay = 0.0, delayAt: Int?
    var active = false
    func name(_ e: ProbeEvent) -> String { e.type + (e.keyCode.map { "-\($0)" } ?? "") }
    var environment: ProbeEnvironment {
        ProbeEnvironment(now: { self.time }, pause: { self.time += $0; self.pauseCount += 1 }, check: {
            self.checks += 1
            if self.inputHeld { self.checkedWhileHeld = true }
            if self.checks == self.failCheck { throw ProbeFault("GUARD_FAILED") }
            if let at = self.interruptAt, self.time >= at { throw ProbeFault("CANCELLED") }
        }, identity: {
            self.identities += 1
            if self.inputHeld { self.fullIdentitiesWhileHeld += 1 }
            if let count = self.loseIdentityAfter, self.posts.count >= count { throw ProbeFault("PROCESS_IDENTITY_CHANGED") }
        }, releaseIdentity: { self.startReads += 1 }, noHold: {}, pointerGeometry: {}, belief: {
            self.beliefTimeout ? false : self.beliefStuck ? true : self.active
        }, post: { e in
            self.posts.append(self.name(e))
            if e.release != nil { self.inputHeld = true }
            if e.type == "keyUp" || e.type == "leftMouseUp" { self.inputHeld = false }
            if e.type == "applicationActivated" { self.active = true }
            if e.type == "applicationDeactivated" { self.active = false }
            if self.posts.count == self.delayAt { self.time += self.postDelay }
            if self.posts.count == self.failPost { throw ProbeFault("POST_FAILED") }
        })
    }
}
@main enum FakeTests {
    static func main() throws {
        probeInstallSignals()
        var passed = 0, failed = 0, maxCriticalSectionMs = 0.0
        func check(_ condition: Bool, _ name: String) {
            if condition { passed += 1 } else { failed += 1; FileHandle.standardError.write(Data((name + "\n").utf8)) }
        }
        func events(_ row: String) throws -> [ProbeEvent] {
            var r: [String: Any] = ["version": 1, "pid": 321, "window": 654, "row": row, "mode": "background"]
            if row == "click" || row == "move" { r["point"] = [12, 25]; r["toolbarHeight"] = 48; r["titleBarHeight"] = 32; r["coordinateMapping"] = "window-bottom-left-to-cg-top-left" }
            if row == "unicode" { r["mode"] = "foreground"; r["mappedQConfirmed"] = true }
            return probeEvents(try ProbeRequest(r))
        }
        let bound = try ProbeRequest(["version": 1, "pid": 321, "window": 654, "row": "mapped-keys", "mode": "background"])
        try probeNoHold("fixture", inspect: { _, _ in errno = ENOENT; return -1 })
        check(true, "ENOENT is the only allowed hold result")
        for failure in [EACCES, EPERM, EIO, ENOTDIR, ELOOP, EINTR] {
            do { try probeNoHold("fixture", inspect: { _, _ in errno = failure; return -1 }); check(false, "hold stat error accepted") }
            catch { check((error as? ProbeFault)?.code == "TIMED_WINDOW_HOLD", "hold stat error refused \(failure)") }
        }
        do { try probeNoHold("fixture", inspect: { _, _ in errno = ENOENT; return 0 }); check(false, "existing hold with stale ENOENT accepted") }
        catch { check((error as? ProbeFault)?.code == "TIMED_WINDOW_HOLD", "existing hold refused with stale ENOENT") }
        let holdLink = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("hold-link")
        try FileManager.default.createSymbolicLink(atPath: holdLink.path, withDestinationPath: holdLink.appendingPathComponent("absent").path)
        defer { try? FileManager.default.removeItem(at: holdLink) }
        do { try probeNoHold(holdLink.path); check(false, "dangling hold accepted") }
        catch { check((error as? ProbeFault)?.code == "TIMED_WINDOW_HOLD", "real lstat refuses dangling fixture link") }
        let identity = ProbeProcessIdentity(pid: 321, bundle: "com.utmapp.UTM", start: ProbeStartTime(seconds: 100, microseconds: 0), executable: URL(fileURLWithPath: "/Applications/UTM.app/Contents/MacOS/UTM"))
        try probeVerifyProcess(identity, request: bound, expected: identity)
        check(true, "exact process accepted")
        for other in [
            ProbeProcessIdentity(pid: 322, bundle: identity.bundle, start: identity.start, executable: identity.executable),
            ProbeProcessIdentity(pid: 321, bundle: "other.app", start: identity.start, executable: identity.executable),
            ProbeProcessIdentity(pid: 321, bundle: identity.bundle, start: ProbeStartTime(seconds: 100, microseconds: 1), executable: identity.executable),
            ProbeProcessIdentity(pid: 321, bundle: identity.bundle, start: identity.start, executable: URL(fileURLWithPath: "/fixture/replaced"))
        ] {
            do { try probeVerifyProcess(other, request: bound, expected: identity); check(false, "changed process accepted") }
            catch { check(true, "changed process refused") }
        }
        let window: [String: Any] = ["kCGWindowOwnerPID": 321, "kCGWindowLayer": 0, "kCGWindowNumber": 654,
            "kCGWindowBounds": ["X": 10, "Y": 20, "Width": 600, "Height": 400]]
        let selected = try probeSelectWindow([window], bound)
        check(selected.0.width == 600, "exact window accepted")
        let windowCases: [[[String: Any]]] = [[], [window, window],
            [window.merging(["kCGWindowOwnerPID": 999]) { _, n in n }],
            [window.merging(["kCGWindowNumber": 655]) { _, n in n }],
            [window.merging(["kCGWindowLayer": 1]) { _, n in n }],
            [window.merging(["kCGWindowBounds": ["X": 0, "Y": 0, "Width": 0, "Height": 1]]) { _, n in n }]]
        for replacements in windowCases {
            do { _ = try probeSelectWindow(replacements, bound); check(false, "wrong window accepted") }
            catch { check(true, "wrong window refused") }
        }
        for layer in [-1, 1, 3, 8, 25, 101] {
            let panel = window.merging(["kCGWindowLayer": layer, "kCGWindowNumber": 655]) { _, n in n }
            do { _ = try probeSelectWindow([window, panel], bound); check(false, "extra UTM layer \(layer) accepted") }
            catch { check((error as? ProbeFault)?.details["cgWindowCount"] == 2, "extra UTM layer \(layer) refused with count") }
        }
        for row in ["move", "click", "mapped-keys", "belief-keys", "unicode"] {
            let f = FakeProbe(), r = probeRun(try events(row), env: f.environment)
            check(r.ok && r.pending == 0 && r.beliefCleared, "normal \(row)")
            check(r.attempted == f.posts.count, "attempt count \(row)")
        }
        let click = FakeProbe(), clicked = probeRun(try events("click"), env: click.environment)
        check(clicked.releases == 1 && abs(clicked.elapsedMs - 50) < 0.001, "click holds for 50 ms")
        let keys = FakeProbe(), keyed = probeRun(try events("mapped-keys"), env: keys.environment)
        check(keyed.releases == 3 && keys.posts == ["keyDown-12", "keyUp-12", "keyDown-123", "keyUp-123", "keyDown-36", "keyUp-36"], "mapped order")
        for row in ["click", "mapped-keys", "belief-keys", "unicode"] {
            let f = FakeProbe(), result = probeRun(try events(row), env: f.environment)
            check(result.ok && !f.checkedWhileHeld && f.fullIdentitiesWhileHeld == 0, "no full guard or full identity inside \(row) pair")
        }
        for failAt in 1...6 {
            let f = FakeProbe(); f.failPost = failAt
            let r = probeRun(try events("mapped-keys"), env: f.environment)
            let code = [12, 123, 36][(failAt - 1) / 2]
            check(!r.ok && r.pending == 0 && f.posts.last == "keyUp-\(code)", "key cleanup \(failAt)")
        }
        for failAt in [2, 3] {
            let f = FakeProbe(); f.failPost = failAt
            let r = probeRun(try events("click"), env: f.environment)
            check(!r.ok && r.pending == 0 && f.posts.last == "leftMouseUp", "mouse cleanup \(failAt)")
        }
        let cancelled = FakeProbe(); cancelled.interruptAt = 0
        let cancelResult = probeRun(try events("click"), env: cancelled.environment)
        check(!cancelResult.ok && cancelResult.reason == "CANCELLED" && cancelResult.pending == 0 && cancelled.posts.isEmpty, "cancel before pair")
        let timeout = FakeProbe(); timeout.beliefTimeout = true
        let timed = probeRun(try events("belief-keys"), env: timeout.environment)
        check(!timed.ok && timed.beliefCleared && timeout.posts == ["applicationActivated", "applicationDeactivated"], "belief timeout no keys")
        for at in [1, 2, 3, 4, 5, 6, 7, 8] {
            let f = FakeProbe(); f.failPost = at
            let r = probeRun(try events("belief-keys"), env: f.environment)
            check(!r.ok && r.pending == 0 && r.beliefCleared && f.posts.last == "applicationDeactivated", "belief post failure \(at)")
        }
        let lost = FakeProbe(); lost.loseIdentityAfter = 1
        let lostResult = probeRun(try events("mapped-keys"), env: lost.environment)
        check(!lostResult.ok && lostResult.pending == 0 && lost.posts == ["keyDown-12", "keyUp-12"] && lostResult.reason == "PROCESS_IDENTITY_CHANGED", "full identity failure still releases the held key")
        let slow = FakeProbe(); slow.delayAt = 1; slow.postDelay = 0.101
        let slowResult = probeRun(try events("mapped-keys"), env: slow.environment)
        check(!slowResult.ok && slowResult.reason == "CRITICAL_SECTION_EXCEEDED" && slowResult.pending == 0 && slow.posts == ["keyDown-12", "keyUp-12"], "slow pair releases and stops before another press")
        check(slowResult.maxCriticalSectionMs > 100, "slow pair duration reported")
        let slowUnreleased = FakeProbe(); slowUnreleased.delayAt = 1; slowUnreleased.postDelay = 0.101
        slowUnreleased.failPost = 2; slowUnreleased.loseIdentityAfter = 1
        let slowUnreleasedResult = probeRun(try events("mapped-keys"), env: slowUnreleased.environment)
        check(!slowUnreleasedResult.ok && slowUnreleasedResult.pending == 1 && slowUnreleasedResult.reason == "CLEANUP_UNCONFIRMED" &&
            slowUnreleasedResult.criticalSectionExceeded && slowUnreleasedResult.metadata["criticalSectionExceeded"] as? Bool == true,
            "cleanup reason survives critical section overrun and reports both")
        let boundary = FakeProbe(); boundary.delayAt = 1; boundary.postDelay = 0.09
        let boundaryResult = probeRun(try events("mapped-keys"), env: boundary.environment)
        check(boundaryResult.ok && boundaryResult.pending == 0 && abs(boundaryResult.maxCriticalSectionMs - 100) < 0.001,
            "100 ms pair remains within the inclusive cap")
        let stuck = FakeProbe(); stuck.beliefStuck = true
        let stuckResult = probeRun(try events("belief-keys"), env: stuck.environment)
        check(!stuckResult.ok && !stuckResult.beliefCleared && stuckResult.reason == "CLEANUP_UNCONFIRMED", "uncleared belief")
        let late = FakeProbe(); late.delayAt = 1; late.postDelay = 0.401
        let lateResult = probeRun(try events("belief-keys"), env: late.environment)
        check(!lateResult.ok && lateResult.beliefCleared && late.posts == ["applicationActivated", "applicationDeactivated"], "400 ms cap")
        let deadline = FakeProbe(); deadline.delayAt = 1; deadline.postDelay = 2.001
        let deadlineResult = probeRun(try events("mapped-keys"), env: deadline.environment)
        check(!deadlineResult.ok && deadlineResult.pending == 0 && deadline.posts == ["keyDown-12", "keyUp-12"], "deadline releases")
        for at in 1...12 {
            let f = FakeProbe(); f.failCheck = at
            let r = probeRun(try events("belief-keys"), env: f.environment)
            check(r.pending == 0 && r.beliefCleared, "guard cleanup \(at)")
        }
        func request(_ row: String = "mapped-keys", extra: [String: Any] = [:]) throws -> ProbeRequest {
            var r: [String: Any] = ["version": 1, "pid": 321, "window": 654, "row": row, "mode": "background"]
            if row == "click" || row == "move" { r["point"] = [12, 25]; r["toolbarHeight"] = 48; r["titleBarHeight"] = 32; r["coordinateMapping"] = "window-bottom-left-to-cg-top-left" }
            if row == "unicode" { r["mode"] = "foreground"; r["mappedQConfirmed"] = true }
            return try ProbeRequest(r.merging(extra) { _, new in new })
        }
        func runSystem(_ fake: FakeSystem, _ r: ProbeRequest) throws -> (ProbeSystem, ProbeResult) {
            let system = try ProbeSystem(r, cancellation: ProbeCancellation(), services: fake.services)
            return (system, probeRun(probeEvents(r), env: system.environment))
        }
        let initialHold = FakeSystem(); initialHold.held = true
        do { _ = try runSystem(initialHold, request()); check(false, "direct helper startup accepted hold") }
        catch { check((error as? ProbeFault)?.code == "TIMED_WINDOW_HOLD" && initialHold.posts.isEmpty, "direct helper startup refuses hold") }
        for row in ["move", "click", "mapped-keys", "belief-keys", "unicode"] {
            let f = FakeSystem(), r = try request(row)
            if row == "unicode" { f.host = ProbeHostSnapshot(pid: 321, start: f.process.start, window: nil, pointer: f.host.pointer) }
            let (_, result) = try runSystem(f, r)
            maxCriticalSectionMs = max(maxCriticalSectionMs, result.maxCriticalSectionMs)
            check(result.ok && result.pending == 0 && result.beliefCleared, "system success \(row)")
            check(f.destinationPids.count == probeEvents(r).count && f.destinationPids.allSatisfy { $0 == 321 }, "validated post PID \(row)")
            check(f.uiChecks >= (f.posts.count + 1) / 2, "UI rechecked per input section \(row)")
            let pairs = row == "move" ? 0 : row == "click" || row == "unicode" ? 1 : 3
            check(f.startReads == pairs && f.fullReadsWhileHeld == 0, "one kernel read and zero full reads per held pair \(row)")
            check(f.geometryReads == (row == "move" ? 2 : row == "click" ? 3 : 0), "geometry at startup and before pointer moves and presses \(row)")
            check(f.geometryReadsWhileHeld == 0, "no geometry read inside held pair \(row)")
            if row == "click" { check(f.geometryReadsAtPost == [2, 3, 3], "move and down read geometry, up reuses the prepared event") }
            let expectedMs = row == "move" ? 0.0 : row == "click" ? 50.0 : 10.0
            check(abs(result.maxCriticalSectionMs - expectedMs) < 0.001, "hold duration accounted \(row)")
        }
        for row in ["click", "mapped-keys", "belief-keys", "unicode"] {
            for failure in ["start-read", "hold"] {
                let f = FakeSystem(), r = try request(row)
                if row == "unicode" { f.host = ProbeHostSnapshot(pid: 321, start: f.process.start, window: nil, pointer: f.host.pointer) }
                f.afterPost = { name in
                    if name == "leftMouseDown" || name.hasPrefix("keyDown") {
                        if failure == "start-read" { f.startUnavailable = true } else { f.held = true }
                    }
                }
                let (_, result) = try runSystem(f, r)
                let downs = f.posts.filter { $0 == "leftMouseDown" || $0.hasPrefix("keyDown") }
                let ups = f.posts.filter { $0 == "leftMouseUp" || $0.hasPrefix("keyUp") }
                check(!result.ok && result.reason == (failure == "start-read" ? "PROCESS_IDENTITY_UNAVAILABLE" : "TIMED_WINDOW_HOLD") &&
                    result.pending == 0 && result.beliefCleared && downs.count == 1 && ups.count == 1, "\(failure) releases then stops \(row)")
                check(f.startReads == 1 && f.fullReadsWhileHeld == 0, "\(failure) one kernel read while held \(row)")
            }
        }
        let prePressHold = FakeSystem(), prePressRequest = try request()
        let prePressSystem = try ProbeSystem(prePressRequest, cancellation: ProbeCancellation(), services: prePressHold.services)
        prePressHold.afterUICheck = { prePressHold.held = true }
        let prePressResult = probeRun(probeEvents(prePressRequest), env: prePressSystem.environment)
        check(prePressResult.reason == "TIMED_WINDOW_HOLD" && prePressResult.attempted == 0 && prePressResult.pending == 0 && prePressHold.posts.isEmpty,
            "hold immediately before press posts nothing, including no unneeded release")
        for row in ["click", "mapped-keys", "belief-keys", "unicode"] {
            let f = FakeSystem(), r = try request(row)
            if row == "unicode" { f.host = ProbeHostSnapshot(pid: 321, start: f.process.start, window: nil, pointer: f.host.pointer) }
            f.afterPost = { name in if name == "leftMouseDown" || name.hasPrefix("keyDown") { f.time += row == "click" ? 0.051 : 0.091 } }
            let (_, result) = try runSystem(f, r)
            check(!result.ok && result.reason == "CRITICAL_SECTION_EXCEEDED" && result.pending == 0 && result.beliefCleared &&
                result.maxCriticalSectionMs > 100 && f.posts.filter { $0 == "leftMouseDown" || $0.hasPrefix("keyDown") }.count == 1,
                "slow \(row) releases and stops before a second pair")
        }
        let geometry = FakeSystem(), geometryRequest = try request("click")
        let geometrySystem = try ProbeSystem(geometryRequest, cancellation: ProbeCancellation(), services: geometry.services)
        let diagnostic = try geometrySystem.inspection()
        check(geometry.posts.isEmpty && diagnostic["attempted"] as? Int == 0 && diagnostic["axWindowCount"] as? Double == 1, "inspection reads counts without posting")
        check(diagnostic["windowFrame"] as? [Double] == [10, 20, 600, 400] && diagnostic["cgPoint"] as? [Double] == [22, 395], "inspection prints frame and mapped point")
        check(diagnostic["axWindowFrame"] as? [Double] == [10, 20, 600, 400] && diagnostic["axContentFrame"] as? [Double] == [10, 100, 600, 320], "inspection prints independent AX window and content frames")
        check(diagnostic["titleBarHeight"] as? Double == 32 && diagnostic["toolbarHeight"] as? Double == 48, "inspection derives heights from AX frames")
        let keyInspection = FakeSystem()
        let keyInspectionSystem = try ProbeSystem(request(), cancellation: ProbeCancellation(), services: keyInspection.services)
        let measured = try keyInspectionSystem.inspection()
        check(measured["titleBarHeight"] as? Double == 32 && measured["toolbarHeight"] as? Double == 48 && keyInspection.posts.isEmpty,
            "height bootstrap inspection needs no operator heights or posts")
        for badGeometry in [
            ProbeAXGeometry(window: CGRect(x: 11, y: 20, width: 600, height: 400), toolbar: geometry.geometry.toolbar, content: geometry.geometry.content),
            ProbeAXGeometry(window: geometry.geometry.window, toolbar: CGRect(x: 10, y: 10, width: 600, height: 48), content: geometry.geometry.content),
            ProbeAXGeometry(window: geometry.geometry.window, toolbar: geometry.geometry.toolbar, content: CGRect(x: 10, y: 90, width: 600, height: 320)),
            ProbeAXGeometry(window: geometry.geometry.window, toolbar: geometry.geometry.toolbar, content: CGRect(x: 10, y: 100, width: 0, height: 320))
        ] {
            let f = FakeSystem(); f.geometry = badGeometry
            let system = try ProbeSystem(request(), cancellation: ProbeCancellation(), services: f.services)
            do { _ = try system.inspection(); check(false, "invalid AX geometry accepted") }
            catch { check((error as? ProbeFault)?.code == "WINDOW_UNAVAILABLE" && f.posts.isEmpty, "invalid AX geometry refuses without posting") }
        }
        for heights in [[1.0, 1.0], [48, 32], [34.001, 48], [32, 50.001]] {
            let f = FakeSystem()
            do { _ = try runSystem(f, request("click", extra: ["titleBarHeight": heights[0], "toolbarHeight": heights[1]])); check(false, "wrong heights accepted") }
            catch { check((error as? ProbeFault)?.code == "HEIGHT_MISMATCH" && f.posts.isEmpty, "height mismatch has its own refusal \(heights)") }
        }
        for heights in [[30.0, 46.0], [34, 50]] {
            let f = FakeSystem()
            let (system, result) = try runSystem(f, request("click", extra: ["titleBarHeight": heights[0], "toolbarHeight": heights[1]]))
            let inspected = try system.inspection()
            check(result.ok && inspected["attempted"] as? Int == 0, "2 point tolerance applies to live and inspect \(heights)")
        }
        check(diagnostic["appKitCGPoint"] as? [Double] != nil && diagnostic["windowPoint"] as? [Double] == [12, 25] && diagnostic["title"] == nil, "inspection prints raw point without title")
        _ = probeRun(probeEvents(geometryRequest), env: geometrySystem.environment)
        check(geometry.postedPoints == Array(repeating: CGPoint(x: 22, y: 395), count: 3), "every pointer post uses explicit CG frame mapping")
        let shifted = CGRect(x: -800, y: -200, width: 600, height: 400)
        check(try probeGlobalPoint(geometryRequest, bounds: shifted) == CGPoint(x: -788, y: 175), "negative display origin mapping")
        let widerTitle = FakeSystem()
        do { _ = try runSystem(widerTitle, request("move", extra: ["point": [12, 280], "titleBarHeight": 80, "toolbarHeight": 48])); check(false, "explicit title allowance ignored") }
        catch { check((error as? ProbeFault)?.code == "HEIGHT_MISMATCH" && widerTitle.posts.isEmpty, "explicit title height compared with AX") }
        let focused = FakeSystem()
        focused.afterPost = { name in
            if name == "keyDown-12" { focused.host = ProbeHostSnapshot(pid: 888, start: ProbeStartTime(seconds: 300, microseconds: 0), window: nil, pointer: focused.host.pointer) }
        }
        let (focusSystem, focusResult) = try runSystem(focused, request())
        check(!focusResult.ok && focusResult.reason == "PERSON_OR_HOST_CHANGED" && focusSystem.focusChanged, "focus change sampled between posts")
        check(focused.posts == ["keyDown-12", "keyUp-12"] && focusResult.pending == 0, "focus change releases without more keys")
        let focusedWindow = FakeSystem()
        focusedWindow.host = ProbeHostSnapshot(pid: 999, start: ProbeStartTime(seconds: 200, microseconds: 0), window: AXUIElementCreateApplication(999), pointer: .zero)
        focusedWindow.afterPost = { name in
            if name == "keyDown-12" { focusedWindow.host = ProbeHostSnapshot(pid: 999, start: ProbeStartTime(seconds: 200, microseconds: 0), window: AXUIElementCreateApplication(998), pointer: .zero) }
        }
        let (windowFocusSystem, windowFocusResult) = try runSystem(focusedWindow, request())
        check(windowFocusSystem.focusChanged && !windowFocusResult.ok && windowFocusResult.pending == 0, "same-pid focused window change")
        let pointer = FakeSystem()
        pointer.afterPost = { name in
            if name == "keyDown-12" { pointer.host = ProbeHostSnapshot(pid: pointer.host.pid, start: pointer.host.start, window: nil, pointer: .zero) }
        }
        let (pointerSystem, pointerResult) = try runSystem(pointer, request())
        check(pointerSystem.pointerChanged && !pointerResult.ok && pointerResult.pending == 0, "pointer change stops and releases")
        for layer in [-1, 1, 3, 8, 25, 101] {
            for during in [false, true] {
                let f = FakeSystem()
                let panel = f.rows[0].merging(["kCGWindowLayer": layer, "kCGWindowNumber": 655]) { _, new in new }
                if during { f.afterPost = { name in if name == "keyDown-12" { f.rows.append(panel) } } }
                else { f.rows.append(panel) }
                do {
                    let (_, result) = try runSystem(f, request())
                    check(during && result.reason == "WINDOW_AMBIGUOUS" && result.pending == 0 && f.posts == ["keyDown-12", "keyUp-12"], "layer \(layer) before next post")
                } catch { check(!during && (error as? ProbeFault)?.code == "WINDOW_AMBIGUOUS" && f.posts.isEmpty, "layer \(layer) before start") }
            }
        }
        for during in [false, true] {
            let f = FakeSystem()
            if during { f.afterPost = { name in if name == "keyDown-12" { f.blocked = true } } }
            else { f.blocked = true }
            do {
                let (_, result) = try runSystem(f, request())
                check(during && result.reason == "WINDOW_BLOCKED" && result.pending == 0 && f.posts == ["keyDown-12", "keyUp-12"], "attached sheet before next post")
            } catch { check(!during && (error as? ProbeFault)?.code == "WINDOW_BLOCKED" && f.posts.isEmpty, "attached sheet before start") }
        }
        for idle in [0.0, 75, 1999] {
            let f = FakeSystem(); f.idle = idle
            do { _ = try runSystem(f, request()); check(false, "active owner accepted at start") }
            catch {
                let fault = error as? ProbeFault
                check(fault?.code == "PERSON_ACTIVE" && fault?.details["hidIdleMs"] == idle && fault?.details["idleThresholdMs"] == 2000 && f.posts.isEmpty, "measured idle refusal \(idle)")
            }
        }
        let boundaryIdle = FakeSystem(); boundaryIdle.idle = 2000
        check(try runSystem(boundaryIdle, request()).1.ok, "2 second boundary accepted")
        let raisedIdle = FakeSystem()
        do { _ = try runSystem(raisedIdle, request(extra: ["idleSeconds": 5])); check(false, "raised idle bypassed") }
        catch { check((error as? ProbeFault)?.details["idleThresholdMs"] == 5000 && raisedIdle.posts.isEmpty, "raised idle enforced") }
        let ownerReturns = FakeSystem()
        ownerReturns.afterPost = { name in if name == "keyDown-12" { ownerReturns.idle = 75 } }
        let (_, activeResult) = try runSystem(ownerReturns, request())
        check(activeResult.reason == "PERSON_ACTIVE" && activeResult.details["hidIdleMs"] == 85 && activeResult.pending == 0 && ownerReturns.posts == ["keyDown-12", "keyUp-12"], "owner idle before next post includes 10 ms hold")
        for (point, accepted) in [([0.0, 0], false), ([0.0, 1], true), ([599.0, 320], true), ([600.0, 25], false), ([12.0, 320.01], false), ([12.0, 340], false), ([12.0, 399], false)] {
            let f = FakeSystem()
            do { let (_, result) = try runSystem(f, request("click", extra: ["point": point])); check(accepted && result.ok, "content point \(point)") }
            catch { check(!accepted && (error as? ProbeFault)?.code == "POINT_OUTSIDE_CONTENT" && f.posts.isEmpty, "excluded title/toolbar point \(point)") }
        }
        let noContent = FakeSystem()
        do { _ = try runSystem(noContent, request("click", extra: ["toolbarHeight": 400])); check(false, "band exceeds window") }
        catch { check((error as? ProbeFault)?.code == "HEIGHT_MISMATCH" && noContent.posts.isEmpty, "band exceeding window refused as height mismatch") }
        for point in [[12.0, 25.0], [200, 10]] {
            let f = FakeSystem()
            f.geometry = ProbeAXGeometry(window: f.geometry.window, toolbar: f.geometry.toolbar,
                content: CGRect(x: 100, y: 100, width: 400, height: 300))
            do { _ = try runSystem(f, request("click", extra: ["point": point])); check(false, "point outside measured content accepted") }
            catch { check((error as? ProbeFault)?.code == "POINT_OUTSIDE_CONTENT" && f.posts.isEmpty, "measured content excludes x or y \(point)") }
        }
        let inset = FakeSystem()
        inset.geometry = ProbeAXGeometry(window: inset.geometry.window, toolbar: inset.geometry.toolbar,
            content: CGRect(x: 100, y: 100, width: 400, height: 300))
        check(try runSystem(inset, request("click", extra: ["point": [200, 25]])).1.ok, "point inside inset content passes")
        let slowGeometry = FakeSystem(); slowGeometry.geometryDelayWhileHeld = 0.051
        let (_, slowGeometryResult) = try runSystem(slowGeometry, request("click"))
        check(slowGeometryResult.ok && !slowGeometryResult.criticalSectionExceeded && slowGeometryResult.pending == 0 &&
            slowGeometry.geometryReadsWhileHeld == 0 && slowGeometry.geometryReadsAtPost == [2, 3, 3],
            "release never calls AX geometry even when a held read would take 51 ms")
        check(abs(slowGeometryResult.maxCriticalSectionMs - 50) < 0.001 && abs(slowGeometryResult.elapsedMs - 50) < 0.001,
            "critical section and elapsed time exclude the skipped release AX read")
        for row in ["click", "mapped-keys", "belief-keys", "unicode"] {
            for failRelease in [false, true] {
                let f = FakeSystem(), r = try request(row)
                if row == "unicode" { f.host = ProbeHostSnapshot(pid: 321, start: f.process.start, window: nil, pointer: f.host.pointer) }
                let pressIndex = row == "click" || row == "belief-keys" ? 2 : 1
                f.failPost = pressIndex + (failRelease ? 1 : 0)
                f.geometryDelayWhileHeld = 0.051
                let (_, result) = try runSystem(f, r)
                let releaseName = row == "click" ? "leftMouseUp" : row == "unicode" ? "keyUp-0" : "keyUp-12"
                check(!result.ok && result.reason == "POST_FAILED" && result.pending == 0 && result.beliefCleared &&
                    f.posts.filter { $0 == releaseName }.count == (failRelease ? 2 : 1),
                    "failed \(failRelease ? "release" : "press") completes prepared cleanup \(row)")
                check(f.geometryReadsWhileHeld == 0 && f.geometryReads == (row == "click" ? 3 : 0) &&
                    (row != "click" || f.geometryReadsAtPost == (failRelease ? [2, 3, 3, 3] : [2, 3, 3])),
                    "prepared and retried releases perform no AX geometry read \(row)")
                check(abs(result.maxCriticalSectionMs - (failRelease ? (row == "click" ? 50 : 10) : 0)) < 0.001,
                    "failed pair excludes AX geometry time \(row)")
            }
        }
        for at in [2, 3] {
            for change in ["focus", "idle", "identity"] {
                let f = FakeSystem()
                f.afterGeometry = {
                    guard f.geometryReads == at else { return }
                    if change == "focus" {
                        f.host = ProbeHostSnapshot(pid: 888, start: ProbeStartTime(seconds: 300, microseconds: 0), window: nil, pointer: f.host.pointer)
                    } else if change == "idle" { f.idle = 75 }
                    else {
                        f.process = ProbeProcessIdentity(pid: 321, bundle: f.process.bundle,
                            start: ProbeStartTime(seconds: 100, microseconds: 1), executable: f.process.executable)
                    }
                }
                let (_, result) = try runSystem(f, request("click"))
                let expected = change == "focus" ? "PERSON_OR_HOST_CHANGED" : change == "idle" ? "PERSON_ACTIVE" : "PROCESS_IDENTITY_CHANGED"
                check(result.reason == expected && result.pending == 0 && f.posts == (at == 2 ? [] : ["mouseMoved"]),
                    "\(change) during geometry read \(at) refuses before pointer input")
            }
        }
        for after in ["mouseMoved", "leftMouseDown"] {
            for change in ["height", "content", "unavailable", "window"] {
                let f = FakeSystem()
                f.afterPost = { name in
                    guard name == after else { return }
                    if change == "height" {
                        f.geometry = ProbeAXGeometry(window: f.geometry.window,
                            toolbar: CGRect(x: 10, y: 57, width: 600, height: 48), content: CGRect(x: 10, y: 105, width: 600, height: 315))
                    } else if change == "content" {
                        f.geometry = ProbeAXGeometry(window: f.geometry.window, toolbar: f.geometry.toolbar,
                            content: CGRect(x: 100, y: 100, width: 510, height: 320))
                    } else if change == "unavailable" { f.geometryUnavailable = true }
                    else { f.rows[0]["kCGWindowBounds"] = ["X": 11, "Y": 20, "Width": 600, "Height": 400] }
                }
                let (_, result) = try runSystem(f, request("click"))
                let expected = change == "height" ? "HEIGHT_MISMATCH" : change == "content" ? "POINT_OUTSIDE_CONTENT" :
                    change == "window" ? "WINDOW_IDENTITY_CHANGED" : "WINDOW_UNAVAILABLE"
                if after == "mouseMoved" {
                    check(!result.ok && result.reason == expected && result.pending == 0 && f.posts == ["mouseMoved"],
                        "fresh \(change) before press refuses new input")
                } else {
                    check(result.pending == 0 && f.posts == ["mouseMoved", "leftMouseDown", "leftMouseUp"] &&
                        f.geometryReadsAtPost == [2, 3, 3] && f.geometryReadsWhileHeld == 0,
                        "\(change) after down cannot delay release with an AX geometry read")
                    check(change == "window" ? (!result.ok && result.reason == expected) : result.ok,
                        "post-release guards retain window identity checks after \(change)")
                }
            }
        }
        for signalNumber in [SIGINT, SIGTERM, SIGHUP, SIGQUIT, SIGTSTP, SIGCONT] {
            for row in ["click", "mapped-keys", "belief-keys"] {
                probeInterrupted = 0
                let f = FakeSystem()
                f.afterPost = { name in if name == "leftMouseDown" || name == "keyDown-12" { raise(signalNumber) } }
                let (_, result) = try runSystem(f, request(row))
                check(result.reason == "CANCELLED" && result.pending == 0 && result.beliefCleared && !f.active, "signal \(signalNumber) releases \(row)")
                check(f.posts.contains(row == "click" ? "leftMouseUp" : "keyUp-12") && !f.posts.contains("keyDown-123"), "signal \(signalNumber) no further press \(row)")
            }
        }
        probeInterrupted = 0
        let reused = FakeSystem()
        reused.afterPost = { name in
            if name == "keyDown-12" { reused.process = ProbeProcessIdentity(pid: 321, bundle: "com.utmapp.UTM", start: ProbeStartTime(seconds: 100, microseconds: 1), executable: reused.process.executable) }
        }
        let (_, reusedResult) = try runSystem(reused, request())
        check(reusedResult.reason == "PROCESS_IDENTITY_CHANGED" && reusedResult.pending == 0 && reused.posts == ["keyDown-12", "keyUp-12"], "kernel change releases once then stops")
        let wrongPid = FakeSystem(); wrongPid.process = ProbeProcessIdentity(pid: 322, bundle: "com.utmapp.UTM", start: ProbeStartTime(seconds: 300, microseconds: 0), executable: wrongPid.process.executable)
        do { _ = try runSystem(wrongPid, request()); check(false, "wrong pid accepted") }
        catch { check((error as? ProbeFault)?.code == "NOT_EXACT_UTM" && wrongPid.posts.isEmpty, "wrong pid never reaches sink") }
        let missing = FakeSystem(), missingRequest = try request("move")
        let missingSystem = try ProbeSystem(missingRequest, cancellation: ProbeCancellation(), services: missing.services)
        missingSystem.prepared.removeAll()
        let missingResult = probeRun(probeEvents(missingRequest), env: missingSystem.environment)
        check(missingResult.reason == "EVENT_NOT_PREPARED" && missing.posts.isEmpty, "prepared lookup failure never posts")
        for change in ["focus", "idle"] {
            let f = FakeSystem(), r = try request()
            let system = try ProbeSystem(r, cancellation: ProbeCancellation(), services: f.services)
            f.afterUICheck = {
                if change == "focus" { f.host = ProbeHostSnapshot(pid: 888, start: ProbeStartTime(seconds: 300, microseconds: 0), window: nil, pointer: f.host.pointer) }
                else { f.idle = 75 }
            }
            let result = probeRun(probeEvents(r), env: system.environment)
            check(!result.ok && f.posts.isEmpty && result.pending == 0, "\(change) during UI inspection refuses first post")
        }
        try probeVerifyWindowUI(role: "AXWindow", subrole: "AXStandardWindow", sheetCount: 0, childRoles: ["AXToolbar", "AXSplitGroup"], modal: false)
        check(true, "ordinary AX window accepted")
        for role in ["AXSheet", "AXDialog", "AXAlert", "AXSystemDialog", "AXPopover", "AXPanel"] {
            do { try probeVerifyWindowUI(role: "AXWindow", subrole: "AXStandardWindow", sheetCount: 0, childRoles: [role], modal: false); check(false, "AX child \(role) accepted") }
            catch { check((error as? ProbeFault)?.code == "WINDOW_BLOCKED", "AX child \(role) refused") }
        }
        for (subrole, sheets, modal) in [("AXDialog", 0, false), ("AXFloatingWindow", 0, false), ("AXStandardWindow", 1, false), ("AXStandardWindow", 0, true)] {
            do { try probeVerifyWindowUI(role: "AXWindow", subrole: subrole, sheetCount: sheets, childRoles: [], modal: modal); check(false, "AX modal/panel accepted") }
            catch { check((error as? ProbeFault)?.code == "WINDOW_BLOCKED", "AX modal/panel refused") }
        }
        probeEmit(["passed": passed, "failed": failed, "maxCriticalSectionMs": maxCriticalSectionMs, "measuredRows": 5, "measuredPairs": 8])
        if failed > 0 { exit(1) }
    }
}
