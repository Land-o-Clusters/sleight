// Supply saved CG metadata and a fixed display. This entry never creates an application or a window.
struct Chv11Screen {
    let frame = CGRect(x: 0, y: 0, width: 1512, height: 982)
    let visibleFrame = CGRect(x: 0, y: 0, width: 1512, height: 952)
}
let chv11Screens = [Chv11Screen()]
if CommandLine.arguments.dropFirst().first == "--chv11-world" {
    let raw = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [String: Any]
    let frame = spriteFrame(raw["frame"] as! [String: Any])!
    let pair = [CGRect(x: 29, y: 592, width: 668, height: 350), CGRect(x: 30, y: 592, width: 666, height: 350)]
    func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
    let rows = (0..<2).map { direction -> [String: Any] in
        let initial = pair[direction]
        let observed = raw["threePoint"] as? Bool == true ? initial.offsetBy(dx: 3, dy: 0) : pair[1 - direction]
        var current = initial
        let env = PerchEnvironment(world: { pid, id in
            let row: [String: Any] = [kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowNumber as String: NSNumber(value: id),
                kCGWindowBounds as String: current.dictionaryRepresentation, kCGWindowLayer as String: 0]
            return perchWorld(pid: pid, window: id, snapshot: [row])
        }, reduced: { true }, measure: { _ in .zero })
        var runtime = PerchRuntime(); runtime.load(frame); runtime.book.enabled = false
        let event = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil)
        _ = runtime.receive(event, now: 0, env: env)
        precondition(runtime.seat!.frame == initial && runtime.shown)
        current = observed
        let effects = runtime.observe(0.1, env: env)
        let hides = effects.compactMap { _, effect -> String? in if case let .hide(reason, _) = effect { return reason }; return nil }
        let afterMoveShown = runtime.shown
        _ = runtime.observe(0.601, env: env)
        return ["initial": rect(initial), "observed": rect(observed), "hides": hides.count, "reason": hides.first ?? "none",
            "afterMoveShown": afterMoveShown, "afterReturnShown": runtime.shown, "afterReturnFrame": rect(runtime.seat!.frame)]
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!); exit(0)
}
