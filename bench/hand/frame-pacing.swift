import AppKit
import CoreMedia
import CryptoKit
import Foundation
import ScreenCaptureKit

// ST9: captures only the explicitly named panel window, never a display or region. Run separately from the CPU pass.
// frame-pacing --window ID --pid PID --hz 60|120 --duration-ms 600|400
// Start the host with capture visible. After {ready:true}, trigger the motion and send {"start":true}\n on stdin.
// The final JSON retains only presentation timestamps and pixel hashes, never images or window titles.
// --self-test and --recorder-self-test check hashing without consulting a display. --dry-run describes the command without capture access.

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(70) }
    FileHandle.standardOutput.write(data + Data([10]))
}
func fail(_ code: String) -> Never { emit(["ok": false, "error": code]); exit(2) }
func streamStopped(_ error: Error) -> [String: Any] {
    let value = error as NSError
    return ["ok": false, "error": "stream-stopped", "code": value.code,
        "description": value.localizedDescription, "domain": value.domain]
}

// Exclude row padding. WindowServer may leave those bytes undefined between otherwise equal frames.
func pixelHash(_ bytes: UnsafeRawPointer, width: Int, height: Int, stride: Int) -> String {
    var hash = SHA256()
    for y in 0..<height { hash.update(data: Data(bytes: bytes.advanced(by: y * stride), count: width * 4)) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func selfTest() {
    var a: [UInt8] = [1,2,3,4,99,99,99,99,5,6,7,8,99,99,99,99]
    var b: [UInt8] = [1,2,3,4,0,0,0,0,5,6,7,8,0,0,0,0]
    let h1 = a.withUnsafeBytes { pixelHash($0.baseAddress!, width: 1, height: 2, stride: 8) }
    let h2 = b.withUnsafeBytes { pixelHash($0.baseAddress!, width: 1, height: 2, stride: 8) }
    b[8] = 9
    let h3 = b.withUnsafeBytes { pixelHash($0.baseAddress!, width: 1, height: 2, stride: 8) }
    a.removeAll()
    emit(["ok": h1 == h2 && h1 != h3, "paddingIgnored": h1 == h2, "pixelChangeDetected": h1 != h3, "hash": h1,
          "windowsCreated": 0, "captures": 0])
}

// This bounded log is also used by --samples-dump. All times use the host clock in milliseconds.
// Arrival times diagnose queue delay; only PTS selects the original scheduled motion interval.
struct PacingLog {
    static let capacity = 4096
    let start: Double, durationMs: Int
    var samples: [[String: Any]] = [], frames: [[String: Any]] = []
    var complete = 0, idle = 0, rejected = 0, outside = 0, overflow = false
    mutating func accept(pts: Double, arrival: Double, status: Int, valid: Bool) -> Int? {
        guard samples.count < Self.capacity else { overflow = true; return nil }
        let elapsed = pts - start
        let inside = pts.isFinite && elapsed >= 0 && elapsed < Double(durationMs)
        let accepted = inside && status == SCFrameStatus.complete.rawValue && valid
        if inside {
            if status == SCFrameStatus.complete.rawValue { complete += 1 }
            if status == SCFrameStatus.idle.rawValue { idle += 1 }
            if !valid || (status != SCFrameStatus.complete.rawValue && status != SCFrameStatus.idle.rawValue) { rejected += 1 }
        } else { outside += 1 }
        samples.append(["ptsHostMs": pts.isFinite ? pts as Any : NSNull(), "callbackHostMs": arrival,
            "arrivalDelayMs": pts.isFinite ? arrival - pts as Any : NSNull(), "status": status,
            "valid": valid, "inInterval": inside, "accepted": accepted])
        return accepted ? samples.count - 1 : nil
    }
    // Idle rows remain in samples (status 1, accepted false). Complete and rejected overlap for invalid complete rows.
    var json: [String: Any] { ["scheduledStartHostMs": start, "durationMs": durationMs,
        "samples": samples, "frames": frames, "completeFrames": complete, "idleFrames": idle,
        "rejectedFrames": rejected, "outsideIntervalFrames": outside, "overflow": overflow] }
}
func hostMs() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000 }

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "sleight.stage.frame-pacing")
    let hz: Int
    let durationMs: Int
    let maximumHz: Int
    let windowID: UInt32
    let pid: Int32
    var stream: SCStream?
    var ready = false
    var startTime: Double?
    var finishing = false
    var log: PacingLog?
    let mode: String
    var invalidFrames = 0
    var dimensions: (Int, Int)?
    var changedDimensions = false

    init(hz: Int, durationMs: Int, maximumHz: Int, windowID: UInt32, pid: Int32, mode: String) {
        self.mode = mode
        self.hz = hz; self.durationMs = durationMs; self.maximumHz = maximumHz; self.windowID = windowID; self.pid = pid
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { emit(streamStopped(error)); exit(2) }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        let arrival = hostMs()
        guard type == .screen, !finishing else { return }
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]]
        let status = attachments?.first?[.status] as? Int ?? -1
        if !ready && sample.isValid && status == SCFrameStatus.complete.rawValue {
            ready = true
            emit(["ready": true, "windowID": windowID, "pid": pid, "requestedHz": hz, "maximumHz": maximumHz, "recorderMode": mode])
        }
        guard log != nil else { return }
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
        record(pts: pts, arrival: arrival, status: status, valid: sample.isValid, image: CMSampleBufferGetImageBuffer(sample))
    }
    func record(pts: Double, arrival: Double, status: Int, valid: Bool, image: CVPixelBuffer?) {
        if !valid || SCFrameStatus(rawValue: status) == nil { invalidFrames += 1 }
        guard let index = log!.accept(pts: pts, arrival: arrival, status: status, valid: valid) else {
            if log!.overflow {
                emit(log!.json.merging(["ok": false, "error": "sample-overflow", "started": true,
                    "requestedHz": hz, "maximumHz": maximumHz, "recorderMode": mode]) { _, b in b }); exit(2)
            }; return
        }
        let elapsed = pts - log!.start
        var row: [String: Any] = ["tMs": elapsed, "ptsHostMs": pts, "callbackHostMs": arrival, "arrivalDelayMs": arrival - pts, "hashMs": 0.0]
        guard let image = image, CVPixelBufferGetPixelFormatType(image) == kCVPixelFormatType_32BGRA else {
            invalidFrames += 1; log!.rejected += 1; log!.samples[index]["accepted"] = false; return
        }
        let width = CVPixelBufferGetWidth(image), height = CVPixelBufferGetHeight(image)
        if let d = dimensions { if d.0 != width || d.1 != height { changedDimensions = true } }
        else { dimensions = (width, height) }
        if mode == "hash" {
            guard CVPixelBufferLockBaseAddress(image, .readOnly) == kCVReturnSuccess else { fail("pixel-lock") }
            defer { CVPixelBufferUnlockBaseAddress(image, .readOnly) }
            let stride = CVPixelBufferGetBytesPerRow(image)
            guard width > 0, height > 0, stride >= width * 4, let base = CVPixelBufferGetBaseAddress(image) else { fail("invalid-pixels") }
            let began = hostMs()
            row["hash"] = pixelHash(base, width: width, height: height, stride: stride)
            row["hashMs"] = hostMs() - began
        }
        log!.samples[index]["hashMs"] = row["hashMs"]
        log!.frames.append(row)
    }

    func trigger(_ scheduled: Double?) {
        queue.async {
            guard self.ready, self.startTime == nil else { fail("start-before-ready-or-repeated") }
            let now = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) * 1000
            guard scheduled == nil || scheduled!.isFinite && scheduled! > now && scheduled! < now + 2000 else { fail("invalid-start-time") }
            self.startTime = scheduled ?? now
            self.log = PacingLog(start: self.startTime!, durationMs: self.durationMs)
            self.queue.asyncAfter(deadline: .now() + (self.startTime! - now + Double(self.durationMs + 100)) / 1000) { self.finish() }
        }
    }
    func finish() {
        guard !finishing else { return }
        finishing = true
        let rows = log?.frames ?? []
        let first = rows.first?["tMs"] as? Double, last = rows.last?["tMs"] as? Double
        let achieved: Any = first != nil && last != nil && last! > first! ? Double(rows.count - 1) * 1000 / (last! - first!) : NSNull()
        var result: [String: Any] = ["ok": invalidFrames == 0 && !changedDimensions && log?.overflow == false, "started": startTime != nil,
            "windowID": windowID, "pid": pid, "requestedHz": hz, "maximumHz": maximumHz, "durationMs": durationMs,
            "frames": rows, "captured": rows.count, "achievedHz": achieved, "invalidFrames": invalidFrames,
            "changedDimensions": changedDimensions, "width": dimensions?.0 as Any? ?? NSNull(), "height": dimensions?.1 as Any? ?? NSNull()]
        result.merge(log?.json ?? [:]) { _, b in b }
        result["recorderMode"] = mode
        Task {
            do { try await self.stream?.stopCapture() } catch { fail("stop-capture") }
            emit(result); exit(0)
        }
    }
}

func capture(windowID: UInt32, pid: Int32, hz: Int, durationMs: Int, mode: String) async {
    guard CGPreflightScreenCaptureAccess() else { fail("screen-recording-not-granted") }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    catch { fail("shareable-content") }
    guard let window = content.windows.first(where: { $0.windowID == windowID }), window.isOnScreen,
          window.owningApplication?.processID == pid else { fail("window-owner-mismatch-or-gone") }
    let isHost = await MainActor.run {
        NSRunningApplication(processIdentifier: pid)?.executableURL?.lastPathComponent == "consent-host"
    }
    guard isHost else { fail("window-is-not-consent-host") }
    guard let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else { fail("window-spans-displays") }
    let maximumHz: Int = await MainActor.run {
        NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display.displayID }?.maximumFramesPerSecond ?? 0
    }
    guard maximumHz >= 60 else { fail("display-rate-unknown-or-below-60") }
    if hz == 120 && maximumHz < 120 {
        emit(["ok": true, "verdict": "skipped", "reason": "display-maximum-below-120", "maximumHz": maximumHz, "requestedHz": hz,
              "durationMs": durationMs, "frames": [], "achievedHz": NSNull()]); exit(0)
    }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(hz))
    config.width = max(2, Int((filter.contentRect.width * CGFloat(filter.pointPixelScale)).rounded()))
    config.height = max(2, Int((filter.contentRect.height * CGFloat(filter.pointPixelScale)).rounded()))
    config.showsCursor = false; config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true; config.pixelFormat = kCVPixelFormatType_32BGRA
    config.queueDepth = 8
    let recorder = Recorder(hz: hz, durationMs: durationMs, maximumHz: maximumHz, windowID: windowID, pid: pid, mode: mode)
    let stream = SCStream(filter: filter, configuration: config, delegate: recorder)
    recorder.stream = stream
    do {
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)
        try await stream.startCapture()
    } catch { fail("start-capture") }
    // No host is launched here. The caller owns the panel, motion and cleanup. This deadline owns this helper's stream.
    recorder.queue.asyncAfter(deadline: .now() + .seconds(15)) {
        if recorder.startTime == nil { fail("motion-trigger-timeout") }
    }
    DispatchQueue.global().async {
        let input = FileHandle.standardInput.availableData
        guard input.count <= 128, let row = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
              Set(row.keys) == ["start"] || Set(row.keys) == ["start", "startAtHostMs"], row["start"] as? Bool == true,
              row["startAtHostMs"] == nil || row["startAtHostMs"] is Double else { fail("invalid-motion-trigger") }
        recorder.trigger(row["startAtHostMs"] as? Double)
    }
}

let args = Array(CommandLine.arguments.dropFirst())
if args == ["--stream-error-self-test"] {
    emit(streamStopped(NSError(domain: "SCStreamErrorDomain", code: -3808,
        userInfo: [NSLocalizedDescriptionKey: "Owned window stopped"]))); exit(2)
}
if args == ["--self-test"] { selfTest(); exit(0) }
if args == ["--recorder-self-test"] || args == ["--recorder-overflow-self-test"] {
    var pixel: CVPixelBuffer?
    guard CVPixelBufferCreate(kCFAllocatorDefault, 8, 4, kCVPixelFormatType_32BGRA, nil, &pixel) == kCVReturnSuccess,
        let image = pixel else { fail("pixel-create") }
    guard CVPixelBufferLockBaseAddress(image, []) == kCVReturnSuccess, let base = CVPixelBufferGetBaseAddress(image) else { fail("pixel-lock") }
    memset(base, 42, CVPixelBufferGetBytesPerRow(image) * CVPixelBufferGetHeight(image))
    CVPixelBufferUnlockBaseAddress(image, [])
    var rows: [String: Any] = ["windowsCreated": 0, "captures": 0]
    for mode in ["hash", "timestamps"] {
        let recorder = Recorder(hz: 60, durationMs: 600, maximumHz: 120, windowID: 1, pid: 1, mode: mode)
        recorder.log = PacingLog(start: 1000, durationMs: 600)
        let points = args == ["--recorder-overflow-self-test"] ? (0...PacingLog.capacity).map { 1000 + Double($0) * 599 / Double(PacingLog.capacity) } : [1000.0, 1599.0]
        for pts in points { recorder.record(pts: pts, arrival: pts + 58, status: SCFrameStatus.complete.rawValue, valid: true, image: image) }
        rows[mode] = recorder.log!.json
    }
    emit(rows); exit(0)
}
if args == ["--samples-dump"] {
    while let line = readLine() {
        guard line.utf8.count <= 1048576, let bytes = line.data(using: .utf8),
            let row = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
            let start = row["start"] as? Double, start.isFinite,
            let duration = row["durationMs"] as? Int, [400, 600].contains(duration),
            let samples = row["samples"] as? [[String: Any]], samples.count <= PacingLog.capacity + 1 else { fail("invalid-samples") }
        var log = PacingLog(start: start, durationMs: duration)
        for sample in samples {
            guard let pts = sample["pts"] as? Double, let arrival = sample["arrival"] as? Double, arrival.isFinite,
                let status = sample["status"] as? Int, let valid = sample["valid"] as? Bool else { fail("invalid-samples") }
            if let i = log.accept(pts: pts, arrival: arrival, status: status, valid: valid) {
                log.frames.append(["tMs": pts - start, "ptsHostMs": pts, "callbackHostMs": arrival, "sampleIndex": i])
            }
            if log.overflow { emit(log.json.merging(["ok": false, "error": "sample-overflow"]) { _, b in b }); exit(2) }
        }
        emit(log.json.merging(["windowsCreated": 0, "captures": 0]) { _, b in b })
    }
    exit(0)
}
if args == ["--dry-run"] {
    emit(["dryRun": true, "windowsCreated": 0, "captures": 0,
          "plan": "Use an owned capture-visible panel: --window ID --pid PID --hz 60|120 --duration-ms 600|400. Wait for ready, trigger motion and send {start:true} on stdin. Only window pixels are hashed."])
    exit(0)
}
var values: [String: String] = [:]
guard args.count == 8 || args.count == 10 else { fail("usage") }
for i in stride(from: 0, to: args.count, by: 2) {
    let key = args[i]
    guard ["--window", "--pid", "--hz", "--duration-ms", "--mode"].contains(key), values[key] == nil else { fail("usage") }
    values[key] = args[i + 1]
}
guard let id = UInt32(values["--window"] ?? ""), id > 0, let pid = Int32(values["--pid"] ?? ""), pid > 0,
      let hz = Int(values["--hz"] ?? ""), [60,120].contains(hz), let ms = Int(values["--duration-ms"] ?? ""), [400,600].contains(ms) else { fail("usage") }
let mode = values["--mode"] ?? "hash"
guard ["hash", "timestamps"].contains(mode) else { fail("usage") }
_ = CGMainDisplayID()
Task { await capture(windowID: id, pid: pid, hz: hz, durationMs: ms, mode: mode) }
dispatchMain()
