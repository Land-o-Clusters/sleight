// The install method is copied verbatim, with only its window factory and screen conversion replaced.
// No NSApplication, NSWindow, observers, screenshots or input. Layers render only into memory.
func chv9AppKitRect(_ r: CGRect) -> CGRect { CGRect(x: r.minX, y: 982 - r.maxY, width: r.width, height: r.height) }
final class Chv9View { var layer: CALayer? = CALayer() }
struct Chv9Screen { let backingScaleFactor: CGFloat = 2 }
final class Chv9Panel: HandPanelSurface {
    var frame = CGRect.zero, isVisible = false, sharingType = NSWindow.SharingType.none, ignoresMouseEvents = true
    var contentView: Chv9View? = Chv9View(), screen: Chv9Screen? = Chv9Screen()
    func setFrame(_ r: CGRect, display: Bool) { frame = CGRect(x: floor(r.minX), y: floor(r.minY), width: ceil(r.width), height: ceil(r.height)) }
    func orderOut(_ sender: Any?) { isVisible = false }
    func orderFrontRegardless() { isVisible = true }
}
func chv9MakePanel(capture: String) -> Chv9Panel { Chv9Panel() }
final class Chv9Owner {
    var capture = "hidden", honestMood = HonestMoodCells()
    func showCharacterBadge(_ rect: CGRect?, after: Double, pid: Int32, window: UInt32, current: @escaping () -> Bool) {}
}
class Chv9Installer {
    var loaded: SpriteCharacter?, runtime = PerchRuntime(), stage = StageRuntime(), host: Chv9Owner? = Chv9Owner()
    var panel: Chv9Panel?, root: CALayer?, boxLayer: CALayer?, maskLayer: CALayer?, zs: CAReplicatorLayer?
    var frame = CGRect.null, panelGenerations = 0
#if CHV9_GEOMETRY
    var drawingGeometry: SpritePanelGeometry?
#endif
    var now = 0.0
    func performStage(_ effects: [StageEffect]) { precondition(effects.isEmpty) }
    // PRODUCTION INSTALL
}
// BROKEN INSTALLERS
func chv9NewInstaller(_ broken: String?) -> Chv9Installer {
#if CHV9_GEOMETRY
    switch broken {
    case "no-crop": return Chv9BrokenNoCrop()
    case "extras": return Chv9BrokenExtras()
    case "flip-shift": return Chv9BrokenFlip()
    default: break
    }
#endif
    return Chv9Installer()
}
func chv9InstallTest() {
    func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
    let raw = try! JSONSerialization.jsonObject(with: Data(readLine()!.utf8)) as! [String: Any]
    let frame = spriteFrame(raw["frame"] as! [String: Any])!
    let character = SpriteCharacter.check(frame).character!
    let installer = chv9NewInstaller(raw["broken"] as? String); installer.loaded = character; installer.runtime.load(frame)
    installer.runtime.book.enabled = false
    let windows = (raw["windows"] as! [[String: Any]]).map { row -> (UInt32, CGRect) in
        let r = row["bounds"] as! [String: Double]
        return (UInt32(row["id"] as! Int), CGRect(x: r["x"]!, y: r["y"]!, width: r["width"]!, height: r["height"]!))
    }
    var worldFrames = Dictionary(uniqueKeysWithValues: windows)
    let env = PerchEnvironment(world: { _, id in worldFrames[id].map {
        PerchWorld(window: $0, above: [], display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30, fullScreen: false)
    } }, reduced: { false }, measure: { _ in .zero })
    let mode = raw["mode"] as! String
#if CHV9_GEOMETRY
    if ["crop", "extras", "flip-shift"].contains(mode) {
        chv9Pixels(raw, installer: installer, mode: mode); return
    }
#endif
    var hides: [[String: Any]] = [], installs = 0
    func apply(_ effects: [(Double, PerchEffect)]) {
        for (time, effect) in effects {
            switch effect {
            case let .draw(plan): installer.install(plan); installs += 1
            case let .hide(reason, _): hides.append(["time": time, "reason": reason, "seatFrame": installer.runtime.seat.map { rect($0.frame) } ?? []])
            default: break
            }
        }
    }
    let seed = PerchEvent(state: "aim", pid: 42, window: 7, at: CGPoint(x: 496, y: 837), ok: false, drop: nil, end: nil)
    apply(installer.runtime.receive(seed, now: 0, env: env))
    if mode == "sequence" { worldFrames[7]!.origin.x += 1e-12; worldFrames[7]!.size.width -= 1e-12 }
    if mode.hasPrefix("move") { worldFrames[7]!.origin.x += 3 }
    apply(installer.runtime.observeCall(now: 0.055, env: env, visible: true))
    if mode == "move-roundoff" { worldFrames[7]!.origin.x += 1e-12 }
    if mode.hasPrefix("move") { apply(installer.runtime.observeCall(now: 0.556, env: env, visible: true)) }
    for step in mode.hasPrefix("move") ? [] : raw["steps"] as! [[String: Any]] {
        let args = step["args"] as! [String: Any], at = args["at"] as! [Double], time = (step["atMs"] as! Double) / 1000 + 0.1
        let kind = args["kind"] as? String ?? "thinking", type = step["type"] as! String
        let state = type == "aim" ? "aim" : type == "act" ? kind : args["state"] as! String
        let event = PerchEvent(state: state, pid: 42, window: UInt32(args["windowId"] as! Int), at: CGPoint(x: at[0], y: at[1]),
            ok: args["ok"] as? Bool ?? false, drop: nil, end: nil)
        apply(installer.runtime.receive(event, now: time, env: env))
        if mode == "sequence" {
            // The fixture's integral target geometry expressed through two
            // equivalent CGFloat calculations, independently of the crop.
            let id = UInt32(args["windowId"] as! Int)
            worldFrames[id]!.origin.x += worldFrames[id]!.origin.x > windows[Int(id - 7)].1.minX ? -1e-12 : 1e-12
        }
        apply(installer.runtime.observeCall(now: time + 0.06, env: env, visible: true))
    }
    let output: [String: Any] = ["hides": hides, "shown": installer.runtime.shown, "installs": installs,
        "panel": rect(installer.frame), "seatFrame": installer.runtime.seat.map { rect($0.frame) } ?? []]
    print(String(data: try! JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
}
#if CHV9_GEOMETRY
func chv9Pixels(_ raw: [String: Any], installer: Chv9Installer, mode: String) {
    func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
    func bitmap(_ root: CALayer, panel: CGRect, canvas: CGRect, backing: Int) -> Data {
        let w = Int(ceil(canvas.width)) * backing, h = Int(ceil(canvas.height)) * backing
        let bytes = NSMutableData(length: w * h * 4)!
        let context = CGContext(data: bytes.mutableBytes, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.scaleBy(x: CGFloat(backing), y: CGFloat(backing))
        context.translateBy(x: panel.minX - canvas.minX, y: panel.minY - canvas.minY)
        // NSWindow clips its backing even when the legacy root layer does not.
        context.clip(to: CGRect(origin: .zero, size: panel.size))
        root.render(in: context); return bytes as Data
    }
    let stage = raw["path"] as! String == "stage", original = installer.loaded!.frame
    let cell = stage ? CGSize(width: 320, height: 208) : original.cell
    let w = Int(cell.width) * 8, h = Int(cell.height)
    let ink = CGRect(x: 48, y: 50, width: 64, height: 100), rgba = NSMutableData(length: w * h * 4)!
    let pixels = rgba.mutableBytes.assumingMemoryBound(to: UInt8.self)
    for column in 0..<3 { for y in 50..<150 { for x in 48..<112 {
        let at = (y * w + column * Int(cell.width) + x) * 4
        pixels[at] = UInt8(60 + column * 40); pixels[at + 1] = 120; pixels[at + 2] = 180; pixels[at + 3] = 255
    } } }
    let image = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: CGDataProvider(data: rgba as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    let metrics = PerchMetrics(size: CGSize(width: cell.width / 2, height: cell.height / 2), anchor: .zero, scale: 0.5, legs: (0, 0))
    let flip = mode == "flip-shift", scale = flip ? 0.25 : 0.5
    let entry = SpriteEntry(sheet: "sheet", row: 0, columns: [0, 1, 2], ms: [100, 100, 100], loop: true, flip: flip,
        hotspot: .zero, size: CGSize(width: w, height: h), scale: scale, then: nil)
    let art = stage ? SpriteStagePose(image: image, entry: entry, cell: cell, anchor: .zero, filter: "linear", source: "stage-think", medium: false, ink: ink) : nil
    let seat = PerchSeat(pid: 42, window: 7, x: 100, edge: 250, peek: false, rise: 104,
        frame: CGRect(x: 30, y: 592, width: 666, height: 350), display: CGRect(x: 0, y: 0, width: 1512, height: 982), top: 30)
    var rows: [[String: Any]] = []
    for extra in mode == "extras" ? ["zs", "badge", "detail", "retry", "carrying"] : ["none"] {
        var frame = original; frame.sessionBadge = extra == "badge" ? "1" : nil
        installer.loaded = SpriteCharacter(frame: frame, images: ["sheet": image], stage: SpriteStageCache(frame: frame), ink: ["sheet": ink])
        installer.host!.honestMood.detail = extra == "detail" ? "payment" : nil
        installer.host!.honestMood.retry = extra == "retry"; installer.host!.honestMood.carrying = extra == "carrying"
        var plan = PerchPlan(kind: "test", seat: seat, duration: 1, zs: extra == "zs", zsStill: true, reduced: false)
        plan.positions = [(0, CGPoint(x: 100.125, y: 100.375)), (0.5, CGPoint(x: 121.625, y: 94.875)), (1, CGPoint(x: 108.875, y: 104.125))]
        plan.cells = (0..<32).map { PerchCell(time: Double($0) / 32, state: "perch", entry: entry, column: $0 % 3) }
        installer.runtime.legs = (0, 0)
        // Legacy metrics come from the loaded frame's perch entry. Use this
        // scale for the exact same cell size the installation is tested with.
        if !stage {
            frame.perch = PerchTable(anchor: .zero, table: ["perch": SpriteEntry(sheet: "sheet", row: 0, columns: [0], ms: [100], loop: false,
                flip: false, hotspot: .zero, size: entry.size, scale: 0.5, then: nil)])
            installer.loaded = SpriteCharacter(frame: frame, images: ["sheet": image], stage: SpriteStageCache(frame: frame), ink: ["sheet": ink])
            installer.runtime.load(frame)
        }
        let box = plan.positions.reduce(CGRect.null) { $0.union(CGRect(origin: $1.1, size: metrics.size)) }
        let logical = stage ? stagePanelBounds(plan, metrics) : box.insetBy(dx: -24, dy: -44)
        var inkLookups = 0
        let offset = stage ? CGPoint.zero : spritePanelRoundingOffset(chv9AppKitRect(logical))
        let clip = stage ? logical : CGRect(x: logical.minX + offset.x, y: logical.minY + offset.y, width: ceil(logical.width), height: ceil(logical.height))
        _ = spritePanelGeometry(plan, metrics: metrics, cell: cell, logicalPanel: logical, offset: offset, clip: clip, hasExtras: extra != "none") { _ in inkLookups += 1; return ink }
        installer.install(plan, stageMetrics: stage ? metrics : nil, stagePose: art)
        let layer = installer.boxLayer!, root = installer.root!, panel = chv9AppKitRect(installer.panel!.frame)
        let geometry = installer.drawingGeometry!, full = installer.frame == logical
        let positionTrack = (layer.animation(forKey: "position") as! CAKeyframeAnimation).values!.map { ($0 as! NSValue).pointValue }
        let rectTrack = (layer.animation(forKey: "contentsRect") as! CAKeyframeAnimation).values!.map { ($0 as! NSValue).rectValue }
        let offsetPreserved = positionTrack.enumerated().allSatisfy { i, p in
            p.x == plan.positions[i].1.x - logical.minX + (flip ? metrics.size.width : 0) && p.y == plan.positions[i].1.y - logical.minY
        }
        layer.removeAllAnimations(); root.removeAllAnimations()
        let reference = CALayer(); reference.isGeometryFlipped = true; reference.masksToBounds = stage
        reference.frame = CGRect(origin: .zero, size: clip.size)
        let body = CALayer(); body.anchorPoint = .zero; body.bounds = CGRect(origin: .zero, size: cell)
        body.contents = image; body.contentsGravity = .resize; body.minificationFilter = .linear; body.magnificationFilter = .linear
        body.transform = CATransform3DMakeScale(scale * (flip ? -1 : 1), scale, 1); reference.addSublayer(body)
        var changed = 0, comparisons = 0
        if extra == "none" {
            let canvas = clip.union(panel).integral
            for i in plan.cells.indices { for j in plan.positions.indices { for backing in [1, 2] {
                layer.contentsRect = rectTrack[i]; body.contentsRect = PerchPlan.rect(entry, plan.cells[i].column, cell: cell)
                layer.position = positionTrack[j]
                body.position = CGPoint(x: plan.positions[j].1.x - logical.minX + (flip ? metrics.size.width : 0), y: plan.positions[j].1.y - logical.minY)
                let before = bitmap(reference, panel: clip, canvas: canvas, backing: backing)
                let after = bitmap(root, panel: panel, canvas: canvas, backing: backing)
                precondition(before.withUnsafeBytes { p in stride(from: 3, to: p.count, by: 4).contains { p[$0] != 0 } })
                if before != after { changed += 1 }; comparisons += 1
            } } }
        } else { comparisons = 1 }
        rows.append(["extra": extra, "changed": changed, "comparisons": comparisons, "fullPanel": full, "sameCell": layer.bounds.size == cell,
            "inkLookups": inkLookups, "flipShift": metrics.size.width - cell.width * scale, "offsetPreserved": offsetPreserved,
            "panel": rect(panel), "logical": rect(logical), "drawing": geometry.json, "enclosed": panel.contains(geometry.required)])
    }
    print(String(data: try! JSONSerialization.data(withJSONObject: rows), encoding: .utf8)!)
}
#endif
if CommandLine.arguments.dropFirst().first == "--chv9-install" { chv9InstallTest(); exit(0) }
