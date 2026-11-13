// Window boundaries are in memory. The installer, ring/perch planners, pause
// handler and cost-fixture ingress are production bodies, with a simulated clock.
struct Chv14BadgeDrag {
    var active = false
    mutating func settle() {}
}
final class Chv14Consent { func rebuildMenu() {} }
extension Chv9Installer { var stageActive: Bool { false } }
final class Chv14Host {
    let perch: Chv9Installer
    var pauseTarget: RingEvent?, badgeDrag = Chv14BadgeDrag(), consent: Chv14Consent?
    let pauseControl = CursorPauseControl()
    let cursorStyle = "sprite"
    var ring = RingRuntime(theme: .seamPlus, seed: 1), clock = 0.0, installs = 0, hides = 0, generation = 0
    var env: PerchEnvironment
    init(_ installer: Chv9Installer, _ environment: PerchEnvironment) {
        perch = installer; env = environment
        pauseControl.changed = { [weak self] value in self?.pauseChanged(value) }
    }
    // Only the window release and effect delivery boundaries are substituted.
    func hide() {
        _ = ring.hide(clock); _ = perch.runtime.hide(clock, "hide")
        perch.root?.removeFromSuperlayer(); perch.root = nil
        perch.panel?.orderOut(nil); perch.panel = nil; hides += 1
    }
    func pauseStage(_ paused: Bool) { preconditionFailure("legacy only") }
    // PRODUCTION PAUSE
    func apply(_ effects: [(Double, PerchEffect)]) {
        for (_, effect) in effects {
            switch effect {
            case let .draw(pose):
                if perch.panel == nil { generation += 1 }
                perch.install(pose); installs += 1
            case let .reseat(delta): perch.reseat(delta)
            case .hide: hide()
            case .park, .still:
                func stop(_ layer: CALayer) { layer.removeAllAnimations(); layer.sublayers?.forEach(stop) }
                perch.root.map(stop)
            default: break
            }
        }
    }
    func ringFrame(_ event: RingEvent, delay: Double) {
        let effects = ring.receive(event, delay: delay, now: clock,
            RingEnvironment(bounds: { [self] pid, id in env.world(pid, id)?.window }, reduced: { false }, secure: { false }))
        deliver(effects)
    }
    func deliver(_ effects: [(Double, RingEffect)]) {
        for (_, effect) in effects {
            if case let .draw(plan, _) = effect { apply(perch.runtime.receiveVisible(perchEvent(plan), now: clock, env: env, visible: perch.panel?.isVisible == true)) }
        }
    }
    func advance(_ time: Double) {
        clock = time
        deliver(ring.advance(to: time, RingEnvironment(bounds: { [self] pid, id in env.world(pid, id)?.window }, reduced: { false }, secure: { false })))
        apply(perch.runtime.observeCall(now: time, env: env, visible: perch.panel?.isVisible == true))
    }
    func boundary(_ name: String) -> [String: Any] {
        ["name": name, "shown": perch.runtime.shown && perch.panel?.isVisible == true,
            "panelID": perch.panel == nil ? 0 : generation]
    }
}
final class Chv14Ingress {
    let host: Chv14Host
    var last = -1, seedArrivalMs: Double?, activity = "", shown: StageDraw?
    init(_ host: Chv14Host) { self.host = host }
    func receive(_ row: [String: Any]) {
        guard let hand = handFrame(row) else { preconditionFailure("fixture frame") }
        switch hand {
        // FIXTURE INGRESS
}
if CommandLine.arguments.dropFirst().first == "--chv14-park" {
    let raw = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [String: Any]
    let frame = spriteFrame(raw["frame"] as! [String: Any])!
    let installer = Chv9Installer(); installer.loaded = SpriteCharacter.check(frame).character!; installer.runtime.load(frame)
    installer.runtime.book.enabled = false
    let windows = raw["windows"] as! [[String: Any]]
    let bounds = Dictionary(uniqueKeysWithValues: windows.map { row -> (UInt32, CGRect) in
        let r = row["bounds"] as! [String: Double]
        return (UInt32(row["id"] as! Int), CGRect(x: r["x"]!, y: r["y"]!, width: r["width"]!, height: r["height"]!))
    })
    let env = PerchEnvironment(world: { _, id in bounds[id].map {
        PerchWorld(window: $0, above: [], display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30, fullScreen: false)
    } }, reduced: { false }, measure: { _ in .zero })
    let host = Chv14Host(installer, env), ingress = Chv14Ingress(host)
    let steps = raw["steps"] as! [[String: Any]]
    for step in steps {
        let time = (step["atMs"] as! Double) / 1000
        // Resolve scheduled flourishes and window checks before the next input.
        while host.clock + 0.05 < time { host.advance(host.clock + 0.05) }
        host.advance(time); ingress.receive(step["frame"] as! [String: Any])
    }
    host.advance(61)
    var boundaries = [host.boundary("active-end")]
    let saved = host.pauseTarget != nil
    host.pauseControl.set(true)
    // The fixture settles for 6 seconds before its first parked endpoint.
    host.advance(67); boundaries.append(host.boundary("parked-start"))
    let installs = host.installs, hides = host.hides
    for i in 1...31 { host.advance(67 + Double(i) * 2) }
    boundaries.append(host.boundary("parked-end"))
    let output: [[String: Any]] = [["steps": steps.count, "savedTarget": saved, "paused": host.pauseControl.paused,
        "installs": host.installs, "boundaries": boundaries, "parkedInstalls": host.installs - installs, "parkedHides": host.hides - hides]]
    print(String(data: try! JSONSerialization.data(withJSONObject: output), encoding: .utf8)!); exit(0)
}
