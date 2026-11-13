// Offline fixture only. This harness creates bitmap contexts, never windows.
// The production capture backend is compiled for type checking but never called.
import Foundation
import CoreGraphics

typealias DriverObject = [String: Any]
struct DriverFault: Error {
    let code: String
    let unhealthy: Bool
    init(_ code: String, unhealthy: Bool = false) { self.code = code; self.unhealthy = unhealthy }
}
func driverInteger(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
          n.doubleValue.rounded() == n.doubleValue else { return nil }
    return n.intValue
}
final class DriverRequest {
    let params: DriverObject
    init(_ params: DriverObject) { self.params = params }
    var remaining: Double { 30 }
    func check() throws {}
    func keys(_ required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(params.keys)), Set(params.keys).isSubset(of: required.union(optional)) else {
            throw DriverFault("INVALID_PARAMS")
        }
    }
}
final class EncodeInventory { let fixture: DriverObject? = [:] }
struct EncodeBound { let window: DriverObject }
final class DriverCore {
    let inventory = EncodeInventory()
    var maps: [String: Int] = [:]
    func boundWindow(_ params: DriverObject, request: DriverRequest) throws -> EncodeBound { throw DriverFault("OFFLINE_ONLY") }
    func readTree(_ params: DriverObject, request: DriverRequest) throws -> DriverObject { throw DriverFault("OFFLINE_ONLY") }
}
final class DriverRuntime {
    func register(method: String, handler: @escaping (DriverRequest, DriverCore) throws -> DriverObject) {}
}

func syntheticImage(width: Int, height: Int, calculator: Bool) -> CGImage {
    let context = CGContext(data: nil, width: width * 2, height: height * 2, bitsPerComponent: 8,
        bytesPerRow: width * 8, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: 2, y: 2)
    func fill(_ rect: CGRect, _ gray: CGFloat) {
        context.setFillColor(CGColor(gray: gray, alpha: 1)); context.fill(rect)
    }
    fill(CGRect(x: 0, y: 0, width: width, height: height), 0.89)
    fill(CGRect(x: 0, y: height - 28, width: width, height: 28), 0.77)
    if calculator {
        fill(CGRect(x: 12, y: height - 85, width: width - 24, height: 46), 0.98)
        for row in 0..<5 { for column in 0..<4 {
            let x = 8 + column * (width - 16) / 4, y = 8 + row * (height - 100) / 5
            fill(CGRect(x: x, y: y, width: (width - 24) / 4, height: (height - 115) / 5), column == 3 ? 0.48 : 0.95)
            fill(CGRect(x: x + 17, y: y + 12, width: 9, height: 3), 0.25)
        } }
    } else {
        fill(CGRect(x: 30, y: 18, width: width - 60, height: height - 70), 1)
        // Deterministic varied bars suggest document lines without fonts or app content.
        for row in 0..<((height - 110) / 16) {
            let length = (width - 110) * (60 + (row * 37) % 41) / 100
            for column in stride(from: 0, to: length, by: 9) {
                fill(CGRect(x: 50 + column, y: height - 85 - row * 16, width: 3 + (column + row) % 5, height: 2 + row % 4), 0.17)
            }
        }
    }
    return context.makeImage()!
}

func syntheticBenchmark() throws {
    guard CommandLine.arguments.count == 2, let repeats = Int(CommandLine.arguments[1]), (1...20).contains(repeats) else { exit(64) }
    var rows: [DriverObject] = []
    // Assumed window sizes, not a measurement of any installed app or document.
    for (name, width, height) in [("Calculator", 232, 322), ("TextEdit", 720, 540), ("Word", 1024, 768)] {
        let window: DriverObject = ["windowId": "71", "pid": 42, "processStart": "synthetic",
            "identityVerified": true, "bounds": ["x": -40, "y": 30, "width": width, "height": height]]
        let captured = DriverCapturedImage(image: syntheticImage(width: width, height: height, calculator: name == "Calculator"),
            target: try DriverCaptureTarget(window))
        for format in ["png", "jpeg"] { for scale in ["pixel", "point"] {
            let request = DriverRequest(["format": format, "scale": scale])
            _ = try DriverCaptureService.fields(captured, request: request) // One warmup, excluded.
            var samples: [Double] = [], byteCounts: [Int] = []
            for _ in 0..<repeats {
                try autoreleasepool {
                    let began = ProcessInfo.processInfo.systemUptime
                    let fields = try DriverCaptureService.fields(captured, request: request)
                    samples.append((ProcessInfo.processInfo.systemUptime - began) * 1000)
                    let shot = fields["screenshot"] as! DriverObject
                    byteCounts.append(Data(base64Encoded: shot["data"] as! String)!.count)
                }
            }
            let sorted = samples.sorted()
            rows.append(["synthetic": true, "appSizeLabel": name, "pointWidth": width, "pointHeight": height,
                "sourceWidth": width * 2, "sourceHeight": height * 2, "format": format, "scale": scale,
                "outputWidth": scale == "point" ? width : width * 2, "outputHeight": scale == "point" ? height : height * 2,
                "repeats": repeats, "postCaptureMs": samples, "p50Ms": sorted[(repeats - 1) / 2],
                "minMs": sorted.first!, "maxMs": sorted.last!, "encodedBytes": byteCounts])
        } }
    }
    let result: DriverObject = ["synthetic": true, "captureCount": 0, "jpegQuality": 0.8,
        "timing": "Post-capture resampling, ImageIO encoding, base64 and geometry; excludes image generation, warmup and capture.",
        "rows": rows]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
do { try syntheticBenchmark() } catch { fputs("Synthetic encode failed: \(error)\n", stderr); exit(1) }
