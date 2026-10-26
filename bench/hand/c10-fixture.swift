import AppKit
import CoreGraphics
import CoreAudio
import Foundation
import ImageIO
import IOKit
import ScreenCaptureKit
import UniformTypeIdentifiers
import Vision
import WebKit

// C10 owns these two windows. The stdin protocol never posts input or addresses another app.
// --selftest is arithmetic only. --preflight reads grants and HID idle without prompting.
// --serve DIR HOST_BINARY constructs the fixture only after the JS owner's away and lock gates.
func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) } catch { exit(0) }
}
func idle() -> Double? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }; defer { IOObjectRelease(service) }
    return (IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber).map { $0.doubleValue / 1e9 }
}
// Count separate blue column runs inside the bubble's 12 pt voice-glyph strip only.
// Vertical animation changes heights, while the three x positions stay fixed.
func voicePixels(_ rgba: [UInt8], _ width: Int, _ height: Int) -> [String: Int] {
    var pixels = 0, bars = 0, inBar = false
    for x in 0..<width {
        var column = 0
        for y in 0..<height {
            let i = (y * width + x) * 4
            if abs(Int(rgba[i]) - 91) <= 12 && abs(Int(rgba[i + 1]) - 141) <= 12 && rgba[i + 2] >= 243 && rgba[i + 3] >= 230 { column += 1 }
        }
        pixels += column
        if column > 0 && !inBar { bars += 1 }
        inBar = column > 0
    }
    return ["voiceBars": bars, "voicePixels": pixels]
}
func outputAudio() -> [String: Any] {
    func read<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope,
                 _ element: AudioObjectPropertyElement, _ initial: T) -> T? {
        var value = initial, size = UInt32(MemoryLayout<T>.size)
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr,
              size == MemoryLayout<T>.size else { return nil }
        return value
    }
    let main = kAudioObjectPropertyElementMain, scope = kAudioDevicePropertyScopeOutput
    guard let device: UInt32 = read(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultOutputDevice,
                                   kAudioObjectPropertyScopeGlobal, main, UInt32(0)), device != 0 else {
        return ["muted": NSNull(), "zeroVolume": NSNull(), "reason": "unknown-output"]
    }
    let mainMute: UInt32? = read(device, kAudioDevicePropertyMute, scope, main, UInt32(0))
    let mainVolume: Float32? = read(device, kAudioDevicePropertyVolumeScalar, scope, main, Float32(0))
    let channels: [UInt32] = mainMute != nil && mainVolume != nil ? [main] : [1,2]
    let mutes = channels.map { mainMute ?? read(device, kAudioDevicePropertyMute, scope, $0, UInt32(0)) }
    let volumes: [Float32?] = channels.map { mainVolume ?? read(device, kAudioDevicePropertyVolumeScalar, scope, $0, Float32(0)) }
    return ["muted": mutes.allSatisfy { $0 != nil } ? mutes.allSatisfy { $0 != 0 } as Any : NSNull(),
            "zeroVolume": volumes.allSatisfy { $0?.isFinite == true } ? volumes.allSatisfy { $0 == 0 } as Any : NSNull(),
            "channels": channels.count, "volumes": volumes.map { $0 as Any? ?? NSNull() }, "mutes": mutes.map { $0 as Any? ?? NSNull() }]
}
let args = CommandLine.arguments
func displayRefusal(_ asleep: Bool, _ locked: Bool?) -> String? {
    if locked == nil { return "screen-lock-state-unknown" }
    if locked == true { return "screen-locked" }
    return asleep ? "display-asleep" : nil
}
if args == [args[0], "--display-selftest"] {
    guard let row = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
          let asleep = row["asleep"] as? Bool else { exit(65) }
    emit(["windowsCreated": 0, "reason": displayRefusal(asleep, row["locked"] as? Bool) as Any? ?? NSNull()]); exit(0)
}
if args == [args[0], "--selftest"] { emit(["windowsCreated": 0, "margin": 80, "coveredStopSeconds": 600]); exit(0) }
if args == [args[0], "--voice-pixels-selftest"] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 128 * 1024, let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let width = row["width"] as? Int, let height = row["height"] as? Int, (1...128).contains(width), (1...128).contains(height),
          let base64 = row["rgba"] as? String, let bytes = Data(base64Encoded: base64), bytes.count == width * height * 4 else { exit(65) }
    emit(voicePixels(Array(bytes), width, height).merging(["windowsCreated": 0]) { _, b in b }); exit(0)
}
if args == [args[0], "--preflight"] {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session.map { $0["CGSSessionScreenIsLocked"] as? Bool ?? false }
    if let refusal = displayRefusal(CGDisplayIsAsleep(CGMainDisplayID()) != 0, locked) {
        emit(["ok": false, "error": refusal]); FileHandle.standardError.write(Data((refusal + "\n").utf8)); exit(2)
    }
    emit(["ok": true, "screenRecording": CGPreflightScreenCaptureAccess(), "idle": idle() as Any? ?? NSNull()]); exit(0)
}
guard args.count == 4, args[1] == "--serve", args[2].hasPrefix("/"), args[3].hasSuffix("/bin/consent-host") else { exit(64) }
let output = URL(fileURLWithPath: args[2]).resolvingSymlinksInPath().path
var info = stat()
guard output == args[2], lstat(output, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
      info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else { exit(65) }
guard CGPreflightScreenCaptureAccess() else { exit(2) }

final class Fixture: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var target: NSWindow!, cover: NSWindow!, watcher: Timer?, parent = getppid(), display = 0
    var web: WKWebView?, replayToken: String?
    let originTop: CGFloat = CGDisplayBounds(CGMainDisplayID()).maxY
    func global(_ rect: CGRect) -> CGRect { CGRect(x: rect.minX, y: originTop - rect.maxY, width: rect.width, height: rect.height) }
    func rect(_ r: CGRect) -> [Double] { [Double(r.minX), Double(r.minY), Double(r.width), Double(r.height)] }
    func make(_ title: String) -> NSWindow {
        let w = NSWindow(contentRect: CGRect(x: 200, y: 200, width: 720, height: 420), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.title = title; w.isReleasedWhenClosed = false; w.backgroundColor = .white; w.sharingType = .readOnly
        let label = NSTextField(labelWithString: "C10 fixture. All content is synthetic. No owner app is used.")
        label.frame = CGRect(x: 30, y: 240, width: 650, height: 30); label.textColor = .darkGray
        w.contentView?.addSubview(label)
        return w
    }
    func place(_ index: Int) -> Bool {
        guard NSScreen.screens.indices.contains(index) else { return false }
        display = index
        let screen = NSScreen.screens[index].visibleFrame
        guard screen.width >= 500, screen.height >= 420 else { return false }
        let frame = CGRect(x: screen.minX + 80, y: screen.minY + 60, width: min(720, screen.width - 160), height: min(440, screen.height - 240))
        target.setFrame(frame, display: true); cover.setFrame(frame.insetBy(dx: -15, dy: -140), display: true)
        return true
    }
    func snapshot(_ token: String, extra: [String: Any] = [:]) {
        let buttons = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { kind -> CGRect? in
            guard let button = target.standardWindowButton(kind), let view = button.superview else { return nil }
            return global(target.convertToScreen(view.convert(button.frame, to: nil)))
        }
        let union = buttons.reduce(CGRect.null) { $0.union($1) }, frame = global(target.frame)
        let displays = NSScreen.screens.map { screen -> [String: Any] in
            let f = global(screen.frame), v = global(screen.visibleFrame)
            return ["frame": rect(f), "top": Double(v.minY - f.minY)]
        }
        emit(["event": "reply", "token": token, "pid": Int(getpid()), "id": target.windowNumber, "frame": rect(frame),
              "coverId": cover.windowNumber, "covered": cover.isVisible, "displays": displays, "displayIndex": display,
              "cluster": rect(union), "clusterRightPt": Double(union.maxX - frame.minX), "buttons": buttons.map(rect)].merging(extra) { _, b in b })
    }
    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.accessory)
        target = make("sleight C10 fixture"); cover = make("sleight C10 cover")
        guard place(0) else { finish(2) }
        target.orderFrontRegardless()
        snapshot("ready", extra: ["event": "ready"])
        watcher = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if getppid() != self.parent { self.finish(0) }
            let point = CGEvent(source: nil)?.location
            guard let point = point else { emit(["event": "input", "idle": NSNull()]); return }
            emit(["event": "input", "t": Date().timeIntervalSince1970 * 1000, "x": Double(point.x), "y": Double(point.y), "idle": idle() as Any? ?? NSNull()])
        }
        DispatchQueue.global().async {
            while let line = readLine() {
                guard line.utf8.count <= 8192, let data = line.data(using: .utf8),
                      let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { DispatchQueue.main.async { self.finish(65) }; return }
                DispatchQueue.main.async { self.receive(row) }
            }
            DispatchQueue.main.async { self.finish(0) }
        }
    }
    func finish(_ code: Int32) -> Never { watcher?.invalidate(); cover?.close(); target?.close(); exit(code) }
    func receive(_ row: [String: Any]) {
        guard let token = row["token"] as? String, token.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let op = row["op"] as? String else { finish(65) }
        switch op {
        case "state": snapshot(token)
        case "audio": emit(["event": "reply", "token": token].merging(outputAudio()) { _, b in b })
        case "cover":
            guard let value = row["covered"] as? Bool else { finish(65) }
            if value { cover.orderFrontRegardless() } else { cover.orderOut(nil) }
            snapshot(token)
        case "display":
            guard let index = row["index"] as? Int, place(index) else { emit(["event": "reply", "token": token, "error": "display-unavailable"]); return }
            snapshot(token)
        case "shot":
            guard let name = row["name"] as? String, name.range(of: "^[a-z0-9-]+[.]png$", options: .regularExpression) != nil,
                  let host = row["host"] as? Int32, host > 0, getpgid(host) == getpgid(getpid()) else { finish(65) }
            var path = [CChar](repeating: 0, count: 4096)
            guard proc_pidpath(host, &path, UInt32(path.count)) > 0, String(cString: path) == args[3] else { finish(65) }
            var bubble: CGRect?
            if let values = row["bubble"] as? [Double], values.count == 4, values.allSatisfy({ $0.isFinite }), values[2] > 0, values[3] > 0 {
                bubble = CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
            }
            Task { await capture(name, host, token, bubble, row["ocr"] as? Bool ?? true) }
        case "replay":
            let path = output + "/replay.html"
            var st = stat()
            guard lstat(path, &st) == 0, st.st_mode & S_IFMT == S_IFREG, st.st_uid == getuid(), st.st_size <= 10 * 1024 * 1024,
                  st.st_mode & 0o777 == 0o600, let html = try? String(contentsOfFile: path, encoding: .utf8) else { finish(65) }
            let view = WKWebView(frame: target.contentView!.bounds)
            view.autoresizingMask = [.width, .height]; view.navigationDelegate = self
            target.contentView?.addSubview(view); web = view; replayToken = token
            view.loadHTMLString(html, baseURL: nil)
        default: finish(65)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.scheme == "about" ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let token = replayToken else { return }; replayToken = nil
        webView.evaluateJavaScript("""
        (() => {
          const slider = document.getElementById('timeline');
          const records = JSON.parse(document.getElementById('run-data').textContent);
          for (let i = 0; i < records.length; i++) {
            slider.value = i; slider.dispatchEvent(new Event('input'));
          }
          const image = document.getElementById('screenshot');
          return {positions: records.length, imageShown: !image.hidden && image.src.startsWith('data:image/jpeg;base64,')};
        })()
        """) { value, error in
            guard error == nil, let result = value as? [String: Any] else { emit(["event": "reply", "token": token, "error": "replay-script-failed"]); return }
            emit(["event": "reply", "token": token].merging(result) { _, b in b })
        }
    }
    func capture(_ name: String, _ host: Int32, _ token: String, _ bubble: CGRect?, _ ocr: Bool) async {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let targetWindow = content.windows.first(where: { $0.windowID == UInt32(target.windowNumber) }),
                  let screen = content.displays.first(where: { $0.frame.contains(targetWindow.frame) }) else { throw NSError(domain: "fixture", code: 1) }
            // Only the owned fixture windows and the pinned host binary are included, even when another app overlaps them.
            var region = targetWindow.frame.insetBy(dx: -80, dy: -160).intersection(screen.frame)
            // Voice polling captures only the glyph strip, without full-fixture PNG encoding or OCR.
            if !ocr, let bubble = bubble {
                region = CGRect(x: bubble.minX + 8, y: bubble.minY, width: 12, height: bubble.height).intersection(region)
                guard !region.isNull, !region.isEmpty else { throw NSError(domain: "fixture", code: 5) }
            }
            let owned = content.windows.filter { window in
                window.windowID == UInt32(target.windowNumber) || (cover.isVisible && window.windowID == UInt32(cover.windowNumber)) || window.owningApplication?.processID == host
            }.filter { $0.frame.intersects(region) }
            let filter = SCContentFilter(display: screen, including: owned)
            let config = SCStreamConfiguration(); config.showsCursor = false; config.capturesAudio = false
            config.ignoreShadowsDisplay = true; config.colorSpaceName = CGColorSpace.sRGB
            let scale = CGFloat(filter.pointPixelScale)
            config.width = Int((region.width * scale).rounded()); config.height = Int((region.height * scale).rounded())
            config.sourceRect = region.offsetBy(dx: -screen.frame.minX, dy: -screen.frame.minY)
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let dest = URL(fileURLWithPath: output).appendingPathComponent(name)
            guard !FileManager.default.fileExists(atPath: dest.path),
                  let writer = CGImageDestinationCreateWithURL(dest as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw NSError(domain: "fixture", code: 2) }
            CGImageDestinationAddImage(writer, image, nil)
            guard CGImageDestinationFinalize(writer) else { throw NSError(domain: "fixture", code: 3) }
            chmod(dest.path, 0o600)
            var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let space = CGColorSpace(name: CGColorSpace.sRGB)!
            guard let context = CGContext(data: &bytes, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw NSError(domain: "fixture", code: 4) }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            var ink = 0
            for i in stride(from: 0, to: bytes.count, by: 4) {
                let r = Int(bytes[i]), g = Int(bytes[i + 1]), b = Int(bytes[i + 2])
                if r > 120 && b > 100 && g < 100 && r > g * 3 / 2 && b > g * 3 / 2 { ink += 1 }
            }
            var texts: [String] = []
            if ocr {
                let recognition = VNRecognizeTextRequest(); recognition.recognitionLevel = .accurate
                try VNImageRequestHandler(cgImage: image).perform([recognition])
                texts = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            }
            var voice = ["voiceBars": -1, "voicePixels": -1]
            if let bubble = bubble {
                let strip = CGRect(x: (bubble.minX + 8 - region.minX) * scale, y: (bubble.minY - region.minY) * scale,
                                   width: 12 * scale, height: bubble.height * scale).integral
                if strip.minX >= 0 && strip.minY >= 0 && strip.maxX <= CGFloat(image.width) && strip.maxY <= CGFloat(image.height),
                   let cropped = image.cropping(to: strip) {
                    var glyph = [UInt8](repeating: 0, count: cropped.width * cropped.height * 4)
                    if let inkContext = CGContext(data: &glyph, width: cropped.width, height: cropped.height, bitsPerComponent: 8,
                        bytesPerRow: cropped.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
                        inkContext.draw(cropped, in: CGRect(x: 0, y: 0, width: cropped.width, height: cropped.height))
                        voice = voicePixels(glyph, cropped.width, cropped.height)
                    }
                }
            }
            emit(["event": "reply", "token": token, "screenshot": name, "width": image.width, "height": image.height, "texts": texts,
                  "captureFrame": rect(region),
                  "spritePixels": ink, "includedWindows": owned.count, "hostWindows": owned.filter { $0.owningApplication?.processID == host }.count].merging(voice) { _, b in b })
        } catch { emit(["event": "reply", "token": token, "error": "capture-failed"]) }
    }
}
let app = NSApplication.shared
let fixture = Fixture(); app.delegate = fixture
app.run()
