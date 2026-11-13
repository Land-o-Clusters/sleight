import Foundation
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import CryptoKit

// Clean-room window capture. No display/region fallback: selecting exactly one
// window also excludes separate hand, ring and character panels, even when those
// panels are shareable. The parent still owns app admission and own-host refusal.
struct DriverCaptureTarget {
    let window: DriverObject
    let id: UInt32
    let pid: Int
    let processStart: String
    let bounds: CGRect

    init(_ window: DriverObject) throws {
        guard let text = window["windowId"] as? String, let id = UInt32(text), id > 0,
              String(id) == text, let pid = driverInteger(window["pid"]), pid > 0,
              let start = window["processStart"] as? String, !start.isEmpty,
              window["identityVerified"] as? Bool == true,
              window["minimized"] as? Bool != true,
              let b = window["bounds"] as? DriverObject,
              let x = Self.number(b["x"]), let y = Self.number(b["y"]),
              let w = Self.number(b["width"]), let h = Self.number(b["height"]),
              w > 0, h > 0, w <= 16384, h <= 16384 else {
            throw DriverFault("CAPTURE_TARGET_INVALID")
        }
        self.window = window; self.id = id; self.pid = pid; processStart = start
        bounds = CGRect(x: x, y: y, width: w, height: h)
    }
    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    func matches(_ other: DriverCaptureTarget) -> Bool {
        id == other.id && pid == other.pid && processStart == other.processStart && bounds == other.bounds
    }
    var cacheKey: String { "\(id):\(pid):\(processStart)" }
}

struct DriverCapturedImage {
    let image: CGImage
    let target: DriverCaptureTarget
}

struct DriverCaptureOptions {
    let format: String
    let scale: String
    init(_ params: DriverObject) throws {
        guard params["format"] == nil || ["png", "jpeg"].contains(params["format"] as? String ?? ""),
              params["scale"] == nil || ["point", "pixel"].contains(params["scale"] as? String ?? "") else {
            throw DriverFault("INVALID_PARAMS")
        }
        format = params["format"] as? String ?? "png"
        scale = params["scale"] as? String ?? "pixel"
    }
}

protocol DriverCaptureBackend: AnyObject {
    // Preflight must be a query, never a request for a grant.
    func preflight() -> Bool
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage
}

// A callback that arrives after the request deadline cannot publish or mutate a
// later request. One slot belongs to one request, not to the persistent backend.
final class DriverCaptureSlot<Value> {
    private let lock = NSLock()
    private let ready = DispatchSemaphore(value: 0)
    private var value: Result<Value, Error>?
    private var closed = false
    func finish(_ result: Result<Value, Error>) {
        lock.lock()
        guard !closed && value == nil else { lock.unlock(); return }
        value = result; lock.unlock(); ready.signal()
    }
    func wait(_ request: DriverRequest) throws -> Value {
        try request.check()
        defer { lock.lock(); closed = true; value = nil; lock.unlock() }
        while ready.wait(timeout: .now() + min(0.02, request.remaining)) != .success { try request.check() }
        let status = DispatchTimeoutResult.success
        lock.lock(); closed = true; let result = value; value = nil; lock.unlock()
        guard status == .success, let result = result else {
            throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true)
        }
        try request.check()
        return try result.get()
    }
}

final class DriverWindowCaptureBackend: DriverCaptureBackend {
    private let lock = NSLock()
    private var windows: [String: SCWindow] = [:]
    func preflight() -> Bool { CGPreflightScreenCaptureAccess() }

    func pixelSize(_ target: DriverCaptureTarget, request: DriverRequest) throws -> (Int, Int) {
        guard #available(macOS 14.0, *) else { throw DriverFault("CAPTURE_UNSUPPORTED") }
        let filter = SCContentFilter(desktopIndependentWindow: try find(target, request: request))
        let scale = Double(filter.pointPixelScale)
        guard scale.isFinite, scale >= 0.25, scale <= 4,
              abs(filter.contentRect.width - target.bounds.width) <= 1,
              abs(filter.contentRect.height - target.bounds.height) <= 1 else { throw DriverFault("CAPTURE_SCALE_INVALID") }
        let size = (Int((target.bounds.width * scale).rounded()), Int((target.bounds.height * scale).rounded()))
        try DriverCaptureService.validatePixels(size.0, size.1)
        return size
    }

    @available(macOS 14.0, *)
    private func find(_ target: DriverCaptureTarget, request: DriverRequest) throws -> SCWindow {
        lock.lock(); let cached = windows[target.cacheKey]; lock.unlock()
        if let cached = cached, cached.frame == target.bounds { return cached }
        let slot = DriverCaptureSlot<SCWindow>()
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
            guard error == nil, let content = content else {
                slot.finish(.failure(DriverFault("CAPTURE_UNAVAILABLE"))); return
            }
            let matches = content.windows.filter {
                $0.windowID == target.id && Int($0.owningApplication?.processID ?? 0) == target.pid && $0.frame == target.bounds
            }
            guard matches.count == 1 else { slot.finish(.failure(DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=capture-window"))); return }
            slot.finish(.success(matches[0]))
        }
        let window = try slot.wait(request)
        lock.lock()
        if windows.count >= 16 { windows.removeAll() }
        windows[target.cacheKey] = window; lock.unlock()
        return window
    }

    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        try request.check()
        guard preflight() else { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
        guard #available(macOS 14.0, *) else { throw DriverFault("CAPTURE_UNSUPPORTED") }
        let window = try find(target, request: request)
        try request.check()
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = Double(filter.pointPixelScale)
        guard scale.isFinite, scale >= 0.25, scale <= 4,
              abs(filter.contentRect.width - target.bounds.width) <= 1,
              abs(filter.contentRect.height - target.bounds.height) <= 1 else {
            throw DriverFault("CAPTURE_GEOMETRY_CHANGED")
        }
        let width = Int((target.bounds.width * scale).rounded())
        let height = Int((target.bounds.height * scale).rounded())
        try DriverCaptureService.validatePixels(width, height)
        let config = SCStreamConfiguration()
        config.width = width; config.height = height
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        config.shouldBeOpaque = true
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        if #available(macOS 15.0, *) { config.showMouseClicks = false }
        // A revoked grant must not fall through into an API that can prompt.
        guard preflight() else { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
        let slot = DriverCaptureSlot<CGImage>()
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
            guard error == nil, let image = image else {
                slot.finish(.failure(DriverFault("CAPTURE_UNAVAILABLE"))); return
            }
            slot.finish(.success(image))
        }
        do {
            let image = try slot.wait(request)
            guard image.width == width, image.height == height else { throw DriverFault("CAPTURE_GEOMETRY_CHANGED") }
            return DriverCapturedImage(image: image, target: target)
        }
        catch {
            lock.lock(); windows.removeValue(forKey: target.cacheKey); lock.unlock()
            throw error
        }
    }
}

final class DriverCaptureService {
    let backend: DriverCaptureBackend
    init(backend: DriverCaptureBackend = DriverWindowCaptureBackend()) { self.backend = backend }

    static func validatePixels(_ width: Int, _ height: Int) throws {
        guard width > 0, height > 0, width <= 16384, height <= 16384,
              width <= 16_777_216 / height else { throw DriverFault("CAPTURE_SIZE_LIMIT") }
    }

    // Compare the encoded image the model received, in a fixed 48 point patch.
    // Exact sRGB bytes are intentional: animation or compression drift refuses.
    static func regionHash(_ screenshot: DriverObject, bounds: CGRect, point: CGPoint) throws -> Data {
        guard let encoded = screenshot["data"] as? String, encoded.utf8.count <= 56 * 1024 * 1024,
              let bytes = Data(base64Encoded: encoded), bytes.count <= 40 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? DriverObject,
              let width = driverInteger(properties[kCGImagePropertyPixelWidth as String]),
              let height = driverInteger(properties[kCGImagePropertyPixelHeight as String]) else { throw DriverFault("CAPTURE_ENCODING_FAILED") }
        try validatePixels(width, height)
        guard bounds.width > 0, bounds.height > 0,
              point.x >= bounds.minX, point.x < bounds.maxX, point.y >= bounds.minY, point.y < bounds.maxY,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw DriverFault("CAPTURE_TARGET_INVALID") }
        let sx = Double(width) / bounds.width, sy = Double(height) / bounds.height
        let rect = CGRect(x: floor(max(0, point.x - bounds.minX - 24) * sx),
                          y: floor(max(0, point.y - bounds.minY - 24) * sy),
                          width: 1, height: 1)
        let endX = ceil(min(bounds.width, point.x - bounds.minX + 24) * sx)
        let endY = ceil(min(bounds.height, point.y - bounds.minY + 24) * sy)
        let crop = CGRect(x: rect.minX, y: rect.minY, width: endX - rect.minX, height: endY - rect.minY)
        guard let patch = image.cropping(to: crop),
              let context = CGContext(data: nil, width: patch.width, height: patch.height, bitsPerComponent: 8,
                  bytesPerRow: patch.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw DriverFault("CAPTURE_ENCODING_FAILED") }
        context.draw(patch, in: CGRect(x: 0, y: 0, width: patch.width, height: patch.height))
        guard let data = context.data else { throw DriverFault("CAPTURE_ENCODING_FAILED") }
        return Data(SHA256.hash(data: Data(bytes: data, count: context.bytesPerRow * context.height)))
    }

    static func fields(_ captured: DriverCapturedImage, request: DriverRequest) throws -> DriverObject {
        try request.check()
        let options = try DriverCaptureOptions(request.params)
        var image = captured.image
        let bounds = captured.target.bounds
        try validatePixels(image.width, image.height)
        let sourceX = Double(image.width) / bounds.width, sourceY = Double(image.height) / bounds.height
        guard sourceX >= 0.25, sourceX <= 4, sourceY >= 0.25, sourceY <= 4,
              abs(sourceX - sourceY) <= max(0.03 * max(sourceX, sourceY), 1 / min(bounds.width, bounds.height)) else {
            throw DriverFault("CAPTURE_SCALE_INVALID")
        }
        // Capture still asks ScreenCaptureKit for the same best-resolution image.
        // Point normalization resamples the whole frame, never crops its origin.
        if options.scale == "point" {
            let width = max(1, Int(bounds.width.rounded())), height = max(1, Int(bounds.height.rounded()))
            try validatePixels(width, height)
            if width != image.width || height != image.height {
                guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
                    throw DriverFault("CAPTURE_ENCODING_FAILED")
                }
                context.interpolationQuality = .high
                context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
                guard let scaled = context.makeImage() else { throw DriverFault("CAPTURE_ENCODING_FAILED") }
                image = scaled
            }
        }
        try request.check()
        let sx = Double(image.width) / bounds.width, sy = Double(image.height) / bounds.height
        let bytes = NSMutableData()
        let type = options.format == "jpeg" ? "public.jpeg" : "public.png"
        guard let destination = CGImageDestinationCreateWithData(bytes, type as CFString, 1, nil) else {
            throw DriverFault("CAPTURE_ENCODING_FAILED")
        }
        let properties: CFDictionary? = options.format == "jpeg"
            ? [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary : nil
        CGImageDestinationAddImage(destination, image, properties)
        guard CGImageDestinationFinalize(destination) else { throw DriverFault("CAPTURE_ENCODING_FAILED") }
        try request.check()
        // Leave room below the 64 MiB wire cap for base64 and the full AX tree.
        guard bytes.length <= 40 * 1024 * 1024 else { throw DriverFault("OUTPUT_LIMIT") }
        let rect: DriverObject = ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]
        let scaleX = String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), sx)
        let scaleY = String(format: "%.4f", locale: Locale(identifier: "en_US_POSIX"), sy)
        let note = "Screenshot frame: \(image.width)x\(image.height) pixels; window bounds (\(bounds.minX), \(bounds.minY), \(bounds.width), \(bounds.height)) points; scale \(scaleX)x\(scaleY) pixels per point; origin top-left; window-only, overlays excluded."
        return ["capture": ["status": "ok", "note": note,
                    "sourcePixelWidth": captured.image.width, "sourcePixelHeight": captured.image.height],
                "geometry": ["windowBounds": rect, "pixelWidth": image.width, "pixelHeight": image.height, "scaleX": sx, "scaleY": sy],
                "screenshot": ["data": (bytes as Data).base64EncodedString(), "mimeType": "image/\(options.format)"]]
    }

    // Closures keep all AX work on the runtime's serial request queue. Only the
    // screenshot provider and encoding run concurrently with the tree walk.
    func read(request: DriverRequest, combined: Bool,
              bind: () throws -> DriverObject, tree: () throws -> DriverObject) throws -> DriverObject {
        try request.keys(["windowId", "processStart"], optional: combined ? ["depth", "budgetMs", "format", "scale", "reuseIfUnchanged", "menuRequests"] : ["format", "scale"])
        _ = try DriverCaptureOptions(request.params)
        if combined {
            for (key, range) in [("depth", 0...64), ("budgetMs", 1...30000)] {
                if let value = request.params[key] {
                    guard let n = driverInteger(value), range.contains(n) else { throw DriverFault("INVALID_PARAMS") }
                }
            }
        }
        try request.check()
        let began = ProcessInfo.processInfo.systemUptime
        let before = try DriverCaptureTarget(bind())
        guard backend.preflight() else { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
        let slot = DriverCaptureSlot<DriverObject>()
        DispatchQueue.global(qos: .utility).async { [backend] in
            do {
                let captured = try backend.capture(before, request: request)
                guard before.matches(captured.target) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=capture-target") }
                slot.finish(.success(try Self.fields(captured, request: request)))
            } catch { slot.finish(.failure(error)) }
        }
        var result: DriverObject
        do { result = combined ? try tree() : ["window": before.window] }
        catch {
            // Drain owned capture work before the serial queue admits another
            // request. A deadline while draining still retires the helper.
            let treeError = error
            _ = try slot.wait(request)
            throw treeError
        }
        let capture = try slot.wait(request)
        let after = try DriverCaptureTarget(bind())
        guard before.matches(after) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=capture-target") }
        if combined {
            guard let treeWindow = result["window"] as? DriverObject,
                  before.matches(try DriverCaptureTarget(treeWindow)) else { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=capture-tree") }
        }
        try request.check()
        result["window"] = after.window
        for (key, value) in capture { result[key] = value }
        result["elapsedMs"] = (ProcessInfo.processInfo.systemUptime - began) * 1000
        return result
    }
}

extension DriverRuntime {
    // DriverMain calls this explicitly at integration. Merely compiling this
    // file does not install handlers or query the host's permission state.
    func registerCapture(backend: DriverCaptureBackend? = nil) {
        let service = DriverCaptureService(backend: backend ?? DriverWindowCaptureBackend())
        for method in ["getScreenshot", "getAXStateAndScreenshot"] {
            register(method: method) { request, core in
                // RT2's inventory fixtures must never fall through to host APIs.
                if core.inventory.fixture != nil && backend == nil { throw DriverFault("SCREEN_RECORDING_REQUIRED") }
                do {
                    return try service.read(request: request, combined: method == "getAXStateAndScreenshot",
                        bind: { try core.boundWindow(request.params, request: request).window },
                        tree: { try core.readTree(request.params, request: request) })
                } catch {
                    if let id = request.params["windowId"] as? String { core.maps.removeValue(forKey: id) }
                    throw error
                }
            }
        }
    }
}
