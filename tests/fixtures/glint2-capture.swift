// Generated pixels only. This provider never consults a screen or a window.
final class WireCapture: DriverCaptureBackend {
    func preflight() -> Bool { true }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        let context = CGContext(data: nil, width: Int(target.bounds.width), height: Int(target.bounds.height),
            bitsPerComponent: 8, bytesPerRow: Int(target.bounds.width) * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return DriverCapturedImage(image: context.makeImage()!, target: target)
    }
}
