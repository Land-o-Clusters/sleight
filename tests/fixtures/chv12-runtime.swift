// Production runtimes with saved CG metadata. No applications or windows are created.
struct Chv12Screen {
    let frame = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let visibleFrame = CGRect(x: 0, y: 0, width: 1512, height: 952)
}
let chv12Screens = [Chv12Screen()]
if CommandLine.arguments.dropFirst().first == "--chv12-runtime" {
    let raw = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [String: Any]
    let frame = spriteFrame(raw["frame"] as! [String: Any])!
    let pair = [CGRect(x: 29, y: 592, width: 668, height: 350), CGRect(x: 30, y: 592, width: 666, height: 350)]
    func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
    func difference(_ a: CGRect, _ b: CGRect) -> Double {
        max(abs(a.minX - b.minX), abs(a.minY - b.minY), abs(a.maxX - b.maxX), abs(a.maxY - b.maxY))
    }
    var rows: [[String: Any]] = []
    if raw["edges"] as? Bool == true {
        let a = pair[0]
        let samples = [a.offsetBy(dx: 2, dy: 2), CGRect(x: a.minX + 2, y: a.minY, width: a.width - 4, height: a.height),
            CGRect(x: a.minX + 2, y: a.minY, width: a.width + 1, height: a.height), a.offsetBy(dx: 2.001, dy: 0)]
        rows = [["accepted": samples.map { stageSameWindowBounds(a, $0) }]]
    } else if raw["call"] as? Bool == true {
        var runtime = StageRuntime(); runtime.shown = true
        let effects = stageCallApply([.reseat(CGPoint(x: 1, y: 0))], runtime: &runtime, active: { true }, at: 0.1)
        let hidden = effects.contains { if case .hide = $0 { return true }; return false }
        rows = [["hidden": hidden, "reason": runtime.hiddenReason ?? "none", "shown": runtime.shown]]
    } else if raw["walk"] as? Bool == true {
        let headroom = raw["headroom"] as? Bool == true
        let initial = headroom ? CGRect(x: 29, y: 72, width: 668, height: 350) : pair[0]
        var current = initial
        let env = PerchEnvironment(world: { _, _ in PerchWorld(window: current, above: [], display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30, fullScreen: false) }, reduced: { true }, measure: { _ in .zero })
        var runtime = PerchRuntime(); runtime.load(frame); runtime.book.enabled = false
        _ = runtime.receive(PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil), now: 0, env: env)
        var hideAt: [Int] = [], reseats = 0
        for i in 1...3 {
            current = initial.offsetBy(dx: headroom ? 0 : Double(i), dy: headroom ? -Double(i) : 0)
            for (_, effect) in runtime.observe(Double(i) * 0.5, env: env) {
                if case .hide = effect { hideAt.append(i) }
                if case .reseat = effect { reseats += 1 }
            }
        }
        _ = runtime.advance(to: 1.999, env: env); let beforeReturn = runtime.shown
        let returned = runtime.advance(to: 2.001, env: env)
        let afterReturn = runtime.shown, returnKind = runtime.plan?.kind ?? "none", returnFrame = runtime.seat.map { rect($0.frame) } ?? []
        let reason = returned.compactMap { (_, e) -> String? in if case let .hide(reason, _) = e { return reason }; return nil }.last ?? "none"
        var afterNewAnchor: [Bool] = []
        if !headroom {
            for i in 4...6 {
                current = initial.offsetBy(dx: Double(i), dy: 0)
                _ = runtime.observe(2.1 + Double(i - 4) * 0.1, env: env); afterNewAnchor.append(runtime.shown)
            }
        }
        rows = [["hideAt": hideAt, "reseats": reseats, "beforeReturn": beforeReturn, "afterReturn": afterReturn,
            "returnKind": returnKind, "returnFrame": returnFrame, "returnReason": reason, "afterNewAnchor": afterNewAnchor]]
    } else if raw["panel"] as? Bool == true {
        let installer = Chv9Installer(); installer.loaded = SpriteCharacter.check(frame).character!; installer.runtime.load(frame)
        installer.runtime.book.enabled = false
        var current = pair[0]
        let env = PerchEnvironment(world: { _, _ in PerchWorld(window: current, above: [], display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30, fullScreen: false) }, reduced: { false }, measure: { _ in .zero })
        let event = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil)
        for (_, effect) in installer.runtime.receive(event, now: 0, env: env) { if case let .draw(pose) = effect { installer.install(pose) } }
        let root = installer.root!, layer = installer.boxLayer!, before = installer.panel!.frame
        installer.bubble = Chv9Panel(); installer.bubble!.frame = CGRect(x: 10, y: 20, width: 30, height: 40)
        let bubbleBefore = installer.bubble!.frame
        let badge = installer.host!.pauseOverlay
        badge.owner = installer.panel; badge.panel = Chv12BadgePanel(frame: CGRect(x: 100, y: 758, width: 24, height: 24))
        badge.badgeRect = CGRect(x: 100, y: 200, width: 24, height: 24)
        let badgeBefore = badge.panel!.frame
        let otherOwner = Chv9Panel(); badge.translate(CGPoint(x: 10, y: 20), owner: otherOwner)
        let otherOwnerUnchanged = badge.panel!.frame == badgeBefore
        installer.panel!.operations = []; current = pair[1].offsetBy(dx: 0, dy: raw["dy"] as? Double ?? 0)
        for (_, effect) in installer.runtime.observe(0.1, env: env) { if case let .reseat(delta) = effect { installer.reseat(delta) } }
        let after = installer.panel!.frame
        let badgeAfter = badge.panel!.frame, bubbleAfter = installer.bubble!.frame
        let pendingBadge = badge.badgeRect!
        let delayed = Chv12Badge(), control = CursorPauseControl()
        let originalBadge = CGRect(x: 100, y: 200, width: 24, height: 24)
        delayed.show(originalBadge, sprite: false, after: 5, capture: "hidden", control: control, owner: installer.panel, current: { true })
        let pending = delayed.pending!, pendingCount = chv12BadgeScheduled.count
        delayed.translate(CGPoint(x: 1, y: raw["dy"] as? Double ?? 0), owner: installer.panel)
        let pendingCancelled = pending.isCancelled
        chv12BadgeScheduled.removeFirst().perform()
        let delayedBadge = delayed.panel!.frame
        rows = [["delayedBadge": rect(delayedBadge), "pendingCount": pendingCount, "pendingCancelled": pendingCancelled, "pendingAfterShow": delayed.pending != nil, "badgeDelta": [badgeAfter.minX - badgeBefore.minX, badgeAfter.minY - badgeBefore.minY],
            "bubbleDelta": [bubbleAfter.minX - bubbleBefore.minX, bubbleAfter.minY - bubbleBefore.minY],
            "pendingBadge": rect(pendingBadge), "otherOwnerUnchanged": otherOwnerUnchanged, "sameRoot": root === installer.root, "sameLayer": layer === installer.boxLayer,
            "delta": [after.minX - before.minX, after.minY - before.minY], "operations": installer.panel!.operations, "shown": installer.runtime.shown]]
    } else if raw["stage"] as? Bool == true {
        let key = StageWindowKey(pid: 42, window: 7)
        func world(_ r: CGRect) -> StageWorld {
            StageWorld(base: PerchWorld(window: r, above: [], display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30, fullScreen: false),
                usable: CGRect(x: 0, y: 30, width: 1512, height: 952), person: nil,
                pointer: CGPoint(x: 1500, y: 970), inputAge: 20, pointerAway: 20, windows: [key: r])
        }
        for direction in 0..<(raw["bothDirections"] as? Bool == true ? 2 : 1) {
            var runtime = StageRuntime(), inputFrame = frame
            if raw["noStage"] as? Bool == true { inputFrame.stage = nil }
            runtime.load(inputFrame)
            // Isolate seating tolerance from action-target provenance. The
            // target mode checks that a small move still widens protection.
            let event = PerchEvent(state: raw["reaction"] as? Bool == true ? "error" : "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil, windowRect: nil)
            let protectsTarget = raw["target"] as? Bool == true
            _ = runtime.receive(event, seq: 1, rect: CGRect(x: 480, y: 820, width: 32, height: 32), now: 0, world: world(pair[direction]), reduced: true, protectsTarget: protectsTarget)
            let began = runtime.planBegan
            var hides = 0, draws = 0, reseats = 0, maximumSeatError = 0.0
            for i in 0..<(raw["repeats"] as? Int ?? 1) {
                let current = pair[i % 2 == 0 ? 1 - direction : direction]
                let time = raw["reaction"] as? Bool == true ? (runtime.reactionUntil! + 0.001) : 0.1 + Double(i) * 0.0001
                let effects = runtime.observe(time, world: world(current), reduced: true)
                hides += effects.filter { if case .hide = $0 { return true }; return false }.count
                draws += effects.filter { if case .draw = $0 { return true }; return false }.count
                reseats += effects.filter { String(describing: $0).hasPrefix("reseat") }.count
                if let seat = runtime.seat { maximumSeatError = max(maximumSeatError, difference(seat.world.base.window, current)) }
            }
            let wide = runtime.wideWindows.count, shown = runtime.shown
            let clockPreserved = began == runtime.planBegan
            let reaction = runtime.reaction, installedReaction = runtime.installedReaction
            if !protectsTarget { runtime.admitTargets(event, seq: 1, rect: nil, world: world(pair[direction]), turnEnd: false) }
            _ = runtime.observe(0.2, world: world(pair[1].offsetBy(dx: 3, dy: 0)), reduced: true)
            rows.append(["hides": hides, "wide": wide, "shown": shown, "draws": draws, "reseats": reseats,
                "clockPreserved": clockPreserved, "maximumSeatError": maximumSeatError, "distantWide": runtime.wideWindows.count,
                "reaction": reaction, "installedReaction": installedReaction])
        }
    } else {
        for direction in 0..<2 {
            let initial = pair[direction], observed = (raw["dx"] as? Double).map { initial.offsetBy(dx: $0, dy: 0) } ?? pair[1 - direction]
            var current = initial
            let env = PerchEnvironment(world: { pid, id in
                let row: [String: Any] = [kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowNumber as String: NSNumber(value: id),
                    kCGWindowBounds as String: current.dictionaryRepresentation, kCGWindowLayer as String: 0]
                return perchWorld(pid: pid, window: id, snapshot: [row])
            }, reduced: { true }, measure: { _ in .zero })
            var runtime = PerchRuntime(); runtime.load(frame); runtime.book.enabled = false
            if raw["fixture"] as? Bool == true {
                stageBenchLegacyWindowFrame = { _, _ in ["appKitFrame": [30, 40, 666, 350], "topLeftFrame": [30, 592, 666, 350]] }
            }
            let event = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil)
            _ = runtime.receive(event, now: 0, env: env)
            let originalBegan = runtime.began
            func timers() -> [[String: Any]] { runtime.timers.map { ["at": $0.at, "action": $0.action] } }
            let originalTimers = timers()
            var hides = 0, draws = 0, reseats = 0, maximumSeatError = 0.0
            for i in 0..<(raw["repeats"] as? Int ?? 1) {
                current = i % 2 == 0 ? observed : initial
                let effects = runtime.observe(0.1 + Double(i) * 0.0001, env: env)
                for (_, effect) in effects {
                    if case .hide = effect { hides += 1 }
                    else if case .draw = effect { draws += 1 }
                    else if String(describing: effect).hasPrefix("reseat") { reseats += 1 }
                }
                maximumSeatError = max(maximumSeatError, difference(runtime.seat!.frame, current))
            }
            let owner = HandHost(), host = owner.perch; host.runtime = runtime
            let diagnostics = host.diagnostics
            let shown = runtime.shown, seatFrame = runtime.seat!.frame, began = runtime.began, afterTimers = timers()
            _ = runtime.advance(to: 0.599, env: env); let beforeReturn = runtime.shown
            _ = runtime.advance(to: 0.601, env: env)
            rows.append(["initial": rect(initial), "observed": rect(observed), "seatFrame": rect(seatFrame),
                "hides": hides, "draws": draws, "reseats": reseats, "maximumSeatError": maximumSeatError,
                "shown": shown, "began": began, "originalBegan": originalBegan, "timers": afterTimers, "originalTimers": originalTimers,
                "beforeReturn": beforeReturn, "afterReturn": runtime.shown, "returnFrame": rect(runtime.seat!.frame), "diagnostics": diagnostics])
        }
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!); exit(0)
}
