// Injected into a private copy of consent-host for a no-window native test.
// Image loading, validation, alpha bounds and physical crop use production code.
func chv7Pixels() {
    func rect(_ r: CGRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }
    func emit(_ row: [String: Any]) {
        print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!)
    }
    func bitmap(_ image: CGImage, entry: SpriteEntry, column: Int, cell: CGSize, size: CGSize,
                position: CGPoint, panel: CGRect, canvas: CGRect, backing: Int) -> Data {
        let width = Int(canvas.width) * backing, height = Int(canvas.height) * backing
        let bytes = NSMutableData(length: width * height * 4)!
        let context = CGContext(data: bytes.mutableBytes, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.scaleBy(x: CGFloat(backing), y: CGFloat(backing))
        context.translateBy(x: panel.minX - canvas.minX, y: panel.minY - canvas.minY)
        let root = CALayer(); root.frame = CGRect(origin: .zero, size: panel.size)
        root.isGeometryFlipped = true; root.masksToBounds = true
        let layer = CALayer(); layer.anchorPoint = .zero; layer.bounds = CGRect(origin: .zero, size: cell)
        layer.position = CGPoint(x: position.x - panel.minX + (entry.flip ? size.width : 0), y: position.y - panel.minY)
        layer.transform = CATransform3DMakeScale(size.width / cell.width * (entry.flip ? -1 : 1), size.height / cell.height, 1)
        layer.contents = image; layer.contentsRect = PerchPlan.rect(entry, column, cell: cell)
        layer.contentsGravity = .resize; layer.minificationFilter = .linear; layer.magnificationFilter = .linear
        root.addSublayer(layer); root.render(in: context)
        return bytes as Data
    }
    while let line = readLine() {
        let raw = try! JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
        let frame = spriteFrame(raw["frame"] as! [String: Any])!
        let checked = SpriteCharacter.check(frame)
        guard let character = checked.character else { emit(["error": checked.reason ?? "load"]); exit(1) }
        var sheets: [(String, CGImage, CGSize, [SpriteEntry], CGRect, [String: Double])] = []
        for (key, image) in character.images {
            sheets.append((key, image, frame.cell, frame.allEntries.filter { $0.sheet == key }, character.ink[key]!, [:]))
        }
        var seen = Set<String>()
        for stage in (frame.stage ?? [:]).values {
            guard let file = stage.file, seen.insert(file).inserted else { continue }
            let telemetry = SpriteDecodeTelemetry()
            let decoded = try! SpriteCharacter.decode(file, key: file, frame: frame, stage: stage, telemetry: telemetry)
            sheets.append(((file as NSString).lastPathComponent, decoded.0, stage.cell, [stage.art], decoded.2, telemetry.parts))
        }
        var comparisons = 0, changed = 0, inkChecks = 0, visiblePixels = 0
        var differences: [String] = []
        var areas: [[String: Any]] = []
        for (key, image, cell, entries, ink, telemetry) in sheets {
            let data = image.dataProvider!.data!
            let pixels = CFDataGetBytePtr(data)!
            var expectedInk = CGRect.null, frames = Set<String>()
            for entry in entries { for column in entry.columns {
                let identity = "\(entry.row):\(column)"
                guard frames.insert(identity).inserted else { continue }
                for y in 0..<Int(cell.height) { for x in 0..<Int(cell.width) {
                    let at = ((entry.row * Int(cell.height) + y) * image.width + column * Int(cell.width) + x) * 4
                    if pixels[at + 3] > 0 { expectedInk = expectedInk.union(CGRect(x: x, y: y, width: 1, height: 1)); visiblePixels += 1 }
                } }
            } }
            precondition(expectedInk == ink, "production bounds must include exactly every used nontransparent pixel")
            inkChecks += 1
            for (sizeName, height) in [("small", 104.0), ("medium", 208.0), ("stage", 386.202)] {
                let size = CGSize(width: height * cell.width / cell.height, height: height)
                var points = [CGPoint(x: 100.125, y: 100.375), CGPoint(x: 121.625, y: 94.875)]
                let extent = points.reduce(CGRect.null) { $0.union(CGRect(origin: $1, size: size)) }
                let logical: CGRect
                if sizeName == "small" && ["sheet", "extra", "perch"].contains(key) {
                    let requested = extent.insetBy(dx: -24, dy: -44)
                    let appKit = CGRect(x: requested.minX, y: 982 - requested.maxY, width: requested.width, height: requested.height)
                    let offset = spritePanelRoundingOffset(appKit)
                    points = points.map { CGPoint(x: $0.x + offset.x, y: $0.y + offset.y) }
                    logical = CGRect(x: floor(appKit.minX), y: 982 - floor(appKit.minY) - ceil(appKit.height),
                        width: ceil(appKit.width), height: ceil(appKit.height))
                } else { logical = extent.integral }
                let crop = spriteDrawingBounds(points, size: size, cell: cell, ink: ink, flips: [false, true], clip: logical)
                precondition(logical.contains(crop), "crop must remain within the admitted logical envelope")
                areas.append(["sheet": key, "size": sizeName, "logical": rect(logical), "physical": rect(crop),
                    "reductionPct": (1 - crop.width * crop.height / (logical.width * logical.height)) * 100, "telemetry": telemetry])
                frames.removeAll()
                for original in entries { for column in original.columns {
                    guard frames.insert("\(original.row):\(column)").inserted else { continue }
                    for flip in [false, true] {
                        let entry = SpriteEntry(sheet: original.sheet, row: original.row, columns: original.columns, ms: original.ms,
                            loop: original.loop, flip: flip, hotspot: original.hotspot, size: original.size, scale: original.scale, then: original.then)
                        // Endpoints and an interior point of the unchanged linear motion segment.
                        for point in [points[0], CGPoint(x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2), points[1]] {
                            for backing in [1, 2] {
                                let before = bitmap(image, entry: entry, column: column, cell: cell, size: size, position: point,
                                    panel: logical, canvas: logical, backing: backing)
                                precondition(before.withUnsafeBytes { raw in
                                    stride(from: 3, to: raw.count, by: 4).contains { raw[$0] != 0 }
                                }, "reference frame must draw visible pixels")
                                let after = bitmap(image, entry: entry, column: column, cell: cell, size: size, position: point,
                                    panel: crop, canvas: logical, backing: backing)
                                if before != after {
                                    changed += 1
                                    differences.append("\(key) row=\(entry.row) column=\(column) size=\(sizeName) flip=\(flip) point=\(point) backing=\(backing)")
                                }
                                comparisons += 1
                            }
                        }
                    }
                } }
            }
        }
        var result: [String: Any] = ["pack": raw["name"]!]
        result["comparisons"] = comparisons; result["changed"] = changed; result["inkChecks"] = inkChecks
        result["visiblePixels"] = visiblePixels; result["areas"] = areas; result["differences"] = differences
        emit(result)
    }
}
if arguments == ["--chv7-pixels"] { chv7Pixels(); exit(0) }
