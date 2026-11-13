import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import IOKit
import ScreenCaptureKit
import UniformTypeIdentifiers

// The ghost hand capture test's helper (H5, bench/hand/h5-capture.mjs). Every image it returns is raw 8-bit sRGB RGBA with
// the size on stdout, so the pixel test (bench/hand/pixels.mjs) compares like with like whatever made the capture. It never
// captures a display: ScreenCaptureKit gets one window, or a filter that includes only the target window and the hand's
// panel, cropped to the target window (the launch film's composite stream, bench/capture on claude/p131-cap1fix). It never
// prompts: Screen Recording and Accessibility are only preflighted.
//
//   capture-helper preflight                          {screenRecording, accessibility}
//   capture-helper windows                            on-screen windows front to back, and the frontmost app's pid
//   capture-helper decode <in.png|jpg> <out.rgba>     any image file to raw sRGB RGBA
//   capture-helper encode <in.rgba> <w> <h> <out.png> raw RGBA back to PNG (evidence and tests)
//   capture-helper sck-window <id> <out.rgba>         ScreenCaptureKit, desktop-independent window filter
//   capture-helper sck-composite <id> <pid> <out.rgba> ScreenCaptureKit, the window plus pid's on-screen windows, cropped to it
//   capture-helper hit <x> <y>                        the pid of the accessibility element at a global top-left point
//   capture-helper watch-engine <ms> <seconds>        VC7: one JSON line every ms for seconds, listing only windows whose
//                                                     owner's name ends in "Computer Use" (the engine's own; any layer,
//                                                     on screen or not), with owner, name, layer, alpha, sharing state and
//                                                     bounds. No other app's window is named.
//   capture-helper watch-input <ms> <seconds>         VC7: one JSON line every ms with the real pointer's global
//                                                     top-left position and the HID idle time in seconds
//                                                     (IOHIDSystem HIDIdleTime), for the owner-returned rule. Read only.
// Refusals print {"ok":false,"error":CODE} and exit 2.

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data([10]))
}
func fail(_ code: String, _ detail: String? = nil) -> Never {
    var value: [String: Any] = ["ok": false, "error": code]
    if let detail = detail { value["detail"] = detail }
    emit(value)
    exit(2)
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

// Draws any CGImage into an sRGB RGBA8 buffer (premultiplied last; every capture here is opaque).
func rgba(_ image: CGImage) -> (Data, Int, Int) {
    let width = image.width, height = image.height
    var data = Data(count: width * height * 4)
    data.withUnsafeMutableBytes { raw in
        let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return (data, width, height)
}
func write(_ image: CGImage, to path: String, extra: [String: Any] = [:]) {
    let (data, width, height) = rgba(image)
    do { try data.write(to: URL(fileURLWithPath: path)) } catch { fail("write", error.localizedDescription) }
    emit(["ok": true, "width": width, "height": height].merging(extra) { a, _ in a })
}

func windowList() -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int,
              let layer = info[kCGWindowLayer as String] as? Int, let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        // No titles or owner names: the pixel test needs ids, pids, layers and frames only.
        return ["id": id, "pid": pid, "layer": layer, "alpha": info[kCGWindowAlpha as String] as? Double ?? 1,
                "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
    }
}

// The engine's windows only (owner name ending in "Computer Use", as drag.js's overlay rule), so no other app's names leave.
func engineWindows() -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { info in
        guard let owner = info[kCGWindowOwnerName as String] as? String, owner.hasSuffix("Computer Use"),
              let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int,
              let layer = info[kCGWindowLayer as String] as? Int, let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return ["id": id, "pid": pid, "owner": owner, "name": info[kCGWindowName as String] as? String ?? "", "layer": layer,
                "alpha": info[kCGWindowAlpha as String] as? Double ?? 1, "onScreen": info[kCGWindowIsOnscreen as String] as? Bool ?? false,
                "sharing": info[kCGWindowSharingState as String] as? Int ?? -1,
                "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
    }
}

// Seconds since the last HID input, as ioreg -c IOHIDSystem reports HIDIdleTime (nanoseconds).
func hidIdleSeconds() -> Double? {
    let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }
    guard let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else { return nil }
    return value.doubleValue / 1e9
}

func shareable() async -> SCShareableContent {
    guard CGPreflightScreenCaptureAccess() else { fail("screen-recording-not-granted") }
    do { return try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    catch { fail("shareable-content", error.localizedDescription) }
}
func configuration(size: CGSize, scale: CGFloat) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.ignoreShadowsDisplay = true
    config.colorSpaceName = CGColorSpace.sRGB
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.captureResolution = .best
    config.width = max(2, Int((size.width * scale).rounded()))
    config.height = max(2, Int((size.height * scale).rounded()))
    return config
}
func shoot(_ filter: SCContentFilter, _ config: SCStreamConfiguration) async -> CGImage {
    do { return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    catch { fail("capture", error.localizedDescription) }
}

func sckWindow(_ id: CGWindowID, _ out: String) async {
    let content = await shareable()
    guard let window = content.windows.first(where: { $0.windowID == id }) else { fail("window-gone") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    write(await shoot(filter, configuration(size: filter.contentRect.size, scale: CGFloat(filter.pointPixelScale))), to: out)
}
// The user's recording as the film records it: a display filter that includes only the target window and the hand's windows,
// cropped to the target window. A hand window absent from the shareable content (sharingType none) can't be included.
func sckComposite(_ id: CGWindowID, _ pid: pid_t, _ out: String) async {
    let content = await shareable()
    guard let target = content.windows.first(where: { $0.windowID == id }) else { fail("window-gone") }
    let hands = pid > 0 ? content.windows.filter { $0.owningApplication?.processID == pid && $0.isOnScreen } : []
    guard let display = content.displays.first(where: { $0.frame.contains(target.frame) }) else { fail("window-spans-displays") }
    let filter = SCContentFilter(display: display, including: [target] + hands)
    let config = configuration(size: target.frame.size, scale: CGFloat(filter.pointPixelScale))
    config.sourceRect = target.frame.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
    write(await shoot(filter, config), to: out, extra: ["handWindows": hands.map { Int($0.windowID) }])
}

let args = CommandLine.arguments
func displayRefusal(_ asleep: Bool, _ locked: Bool?) -> String? {
    if locked == nil { return "screen-lock-state-unknown" }
    if locked == true { return "screen-locked" }
    return asleep ? "display-asleep" : nil
}
switch (args.count, args.count > 1 ? args[1] : "") {
case (2, "--display-selftest"):
    guard let row = try? JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
          let asleep = row["asleep"] as? Bool else { exit(65) }
    emit(["windowsCreated": 0, "reason": displayRefusal(asleep, row["locked"] as? Bool) as Any? ?? NSNull()])
case (2, "preflight"), (2, "--preflight"):
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session.map { $0["CGSSessionScreenIsLocked"] as? Bool ?? false }
    if let refusal = displayRefusal(CGDisplayIsAsleep(CGMainDisplayID()) != 0, locked) { fail(refusal) }
    emit(["ok": true, "screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()])
case (2, "windows"):
    emit(["ok": true, "front": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0), "windows": windowList()])
case (4, "decode"):
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("decode") }
    write(image, to: args[3])
case (6, "encode"):
    guard let width = Int(args[3]), let height = Int(args[4]), width > 0, height > 0,
          let data = FileManager.default.contents(atPath: args[2]), data.count == width * height * 4,
          let provider = CGDataProvider(data: data as CFData),
          let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4, space: sRGB,
              bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
              shouldInterpolate: false, intent: .defaultIntent),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[5]) as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fail("encode") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { fail("encode") }
    emit(["ok": true])
case (4, "sck-window"):
    guard let id = UInt32(args[2]) else { fail("usage") }
    _ = CGMainDisplayID() // ScreenCaptureKit needs the window server connection made on the main thread first (cap1, 2026-10-19).
    Task { await sckWindow(id, args[3]); exit(0) }
    dispatchMain()
case (5, "sck-composite"):
    guard let id = UInt32(args[2]), let pid = Int32(args[3]) else { fail("usage") }
    _ = CGMainDisplayID()
    Task { await sckComposite(id, pid, args[4]); exit(0) }
    dispatchMain()
case (4, "hit"):
    guard let x = Float(args[2]), let y = Float(args[3]) else { fail("usage") }
    guard AXIsProcessTrusted() else { fail("accessibility-not-granted") }
    var element: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), x, y, &element)
    var pid: pid_t = 0
    if status == .success, let element = element { AXUIElementGetPid(element, &pid) }
    emit(["ok": status == .success, "pid": Int(pid), "status": Int(status.rawValue)])
case (4, "watch-engine"):
    guard let ms = Int(args[2]), (10...1000).contains(ms), let seconds = Double(args[3]), seconds > 0, seconds <= 600 else { fail("usage") }
    let start = Date()
    while Date().timeIntervalSince(start) < seconds {
        emit(["t": Int((Date().timeIntervalSince1970 * 1000).rounded()), "windows": engineWindows()])
        usleep(useconds_t(ms * 1000))
    }
    emit(["ok": true, "done": true])
case (4, "watch-input"):
    guard let ms = Int(args[2]), (100...5000).contains(ms), let seconds = Double(args[3]), seconds > 0, seconds <= 14400 else { fail("usage") }
    let start = Date()
    while Date().timeIntervalSince(start) < seconds {
        // CGEvent(source: nil) reads the current pointer without posting anything.
        let point = CGEvent(source: nil)?.location ?? .zero
        var line: [String: Any] = ["t": Int((Date().timeIntervalSince1970 * 1000).rounded()), "x": Double(point.x), "y": Double(point.y)]
        if let idle = hidIdleSeconds() { line["idle"] = (idle * 1000).rounded() / 1000 }
        emit(line)
        usleep(useconds_t(ms * 1000))
    }
    emit(["ok": true, "done": true])
default:
    fail("usage")
}
