// Synthetic fixture images only. No screen capture, app automation or window APIs.
import Foundation
import CoreImage
import ImageIO
import Vision

let arguments = CommandLine.arguments
if arguments[1] == "qr" {
    let context = CIContext(options: [.useSoftwareRenderer: true])
    let filter = CIFilter(name: "CIQRCodeGenerator")!
    filter.setValue(Data("https://fixture.invalid/4242".utf8), forKey: "inputMessage")
    filter.setValue("L", forKey: "inputCorrectionLevel")
    let qr = filter.outputImage!
    let modules = CGFloat(Int(arguments[2])!)
    let extent = qr.extent.insetBy(dx: -4, dy: -4)
    let white = CIImage(color: .white).cropped(to: extent)
    let image = qr.composited(over: white).transformed(by: CGAffineTransform(scaleX: modules, y: modules))
    let pixels = context.createCGImage(image, from: image.extent)!
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: arguments[3]) as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, pixels, nil)
    if !CGImageDestinationFinalize(destination) { fatalError("fixture PNG encoding failed") }
} else {
    let url = URL(fileURLWithPath: arguments[2])
    var codes: [String] = []
    var text: [String] = []
    var regions: [[String: Any]] = []
    if arguments[1] == "ocr" {
        FileHandle.standardError.write(Data("vision-ocr-start\n".utf8))
        let request = VNRecognizeTextRequest()
        request.usesCPUOnly = true
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(url: url).perform([request])
        FileHandle.standardError.write(Data("vision-ocr-done\n".utf8))
        text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        regions = (request.results ?? []).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first else { return nil }
            let box = observation.boundingBox
            return ["text": candidate.string, "confidence": candidate.confidence,
                    "x": box.minX, "y": box.minY, "width": box.width, "height": box.height]
        }
    } else {
        FileHandle.standardError.write(Data("vision-qr-start\n".utf8))
        let request = VNDetectBarcodesRequest()
        request.usesCPUOnly = true
        request.symbologies = [.qr]
        try VNImageRequestHandler(url: url).perform([request])
        FileHandle.standardError.write(Data("vision-qr-done\n".utf8))
        codes = (request.results ?? []).compactMap { $0.payloadStringValue }
    }
    let output = try JSONSerialization.data(withJSONObject: ["qr": codes, "text": text, "regions": regions], options: [.sortedKeys])
    print(String(data: output, encoding: .utf8)!)
}
