// Headless fixture QA only, never linked into the Windows host.
import Foundation
import ImageIO
import CoreGraphics

while let line = readLine() {
    guard let bytes = Data(base64Encoded: line),
          let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
          image.width <= 1536, image.height <= 2288 else { exit(65) }
    var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let ok = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
        context.setBlendMode(.copy)
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return true
    }
    guard ok else { exit(65) }
    print(Data(pixels).base64EncodedString())
}
