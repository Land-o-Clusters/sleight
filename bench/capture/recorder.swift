import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import VideoToolbox

// Records windows for the launch film (docs/design/video-storyboard.md). bench/capture/record.mjs resolves the windows and
// writes the plan; this process records every stream of it at once. It captures windows only: a single window through a
// desktop-independent window filter, or a composite (the hand panel over its target window) through a filter that includes
// just those windows, cropped to their union. No cursor and no shadows. Every stream stamps frames on the host clock, and
// sync.json at the stop says where each stream starts on that clock and on the wall clock.
//
//   capture-recorder record <plan.json>   record until the plan's duration ends or SIGINT/SIGTERM, then write sync.json
//   capture-recorder list                 on-screen windows as CGWindowList reports them (titles need Screen Recording)
//   capture-recorder codecs               which encoders AVAssetWriter can use here
//   capture-recorder request-permission   ask macOS for Screen Recording (the prompt names the app that started this)
//
// Plan: {"version":1,"out":ABS_DIR,"fps":60,"duration":SECONDS?,"codec":"prores422hq"|"hevc",
//        "streams":[{"name":"editor","windows":[ID],"composite":false},{"name":"both","windows":[ID,ID],"composite":true}]}
// A composite with "crop":"first" is cropped to its first window's frame instead of the union (VC7's cursor recording: the
// cursor's panel over a fixture window, never anything outside that window).
// Refusals print {"ok":false,"error":CODE,...} and exit 2. A plan is checked whole before ScreenCaptureKit is touched.

func emit(_ value: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func fail(_ code: String, _ detail: String? = nil) -> Never {
    emit(["ok": false, "error": code].merging(detail.map { ["detail": $0] } ?? [:]) { a, _ in a })
    exit(2)
}

struct StreamPlan { let name: String; let windows: [CGWindowID]; let composite: Bool; var cropFirst = false; var followOwners = false }
struct Plan { let out: URL; let fps: Int; let duration: Double?; let codec: String; let streams: [StreamPlan]; let scale: Double? }

let codecs = ["prores422hq": AVVideoCodecType.proRes422HQ, "hevc": AVVideoCodecType.hevc]

func readPlan(_ path: String) -> Plan {
    guard let data = FileManager.default.contents(atPath: path),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { fail("bad-plan") }
    guard raw["version"] as? Int == 1 else { fail("bad-version") }
    guard let rawStreams = raw["streams"] as? [[String: Any]], !rawStreams.isEmpty,
          rawStreams.allSatisfy({ !(($0["windows"] as? [Any]) ?? []).isEmpty }) else { fail("no-window", "the plan names no window") }
    var names = Set<String>()
    let streams: [StreamPlan] = rawStreams.map { item in
        guard let name = item["name"] as? String, name.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", options: .regularExpression) != nil,
              names.insert(name).inserted, let ids = item["windows"] as? [Int], ids.allSatisfy({ $0 > 0 && $0 <= Int(UInt32.max) }),
              Set(ids).count == ids.count, let composite = item["composite"] as? Bool, composite == (ids.count > 1),
              item["crop"] == nil || (composite && item["crop"] as? String == "first"),
              item["followOwners"] == nil || (item["followOwners"] as? Bool == true && composite && item["crop"] as? String == "first") else { fail("bad-stream") }
        return StreamPlan(name: name, windows: ids.map { CGWindowID($0) }, composite: composite, cropFirst: item["crop"] != nil, followOwners: item["followOwners"] as? Bool ?? false)
    }
    var isDirectory: ObjCBool = false
    guard let out = raw["out"] as? String, out.hasPrefix("/"), FileManager.default.fileExists(atPath: out, isDirectory: &isDirectory),
          isDirectory.boolValue else { fail("bad-out") }
    guard let fps = raw["fps"] as? Int, (1...120).contains(fps) else { fail("bad-fps") }
    let duration = raw["duration"] as? Double
    if raw["duration"] != nil && !(raw["duration"] is NSNull) { guard let seconds = duration, seconds > 0 else { fail("bad-duration") } }
    guard let codec = raw["codec"] as? String, codecs[codec] != nil else { fail("bad-codec") }
    let scale = raw["scale"] as? Double
    guard raw["scale"] == nil || scale == 2 else { fail("bad-scale") }
    return Plan(out: URL(fileURLWithPath: out, isDirectory: true), fps: fps, duration: duration, codec: codec, streams: streams, scale: scale)
}

func outputSettings(_ codec: String, width: Int, height: Int) -> [String: Any] {
    var settings: [String: Any] = [AVVideoCodecKey: codecs[codec]!, AVVideoWidthKey: width, AVVideoHeightKey: height]
    // Quality 1.0 asks VideoToolbox for its least lossy HEVC; whether this encoder makes it bit-exact is unmeasured.
    if codec == "hevc" { settings[AVVideoCompressionPropertiesKey] = [kVTCompressionPropertyKey_Quality as String: 1.0] }
    return settings
}

func codecAvailability() -> [String: Bool] {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("sleight-capture-codecs-\(getpid()).mov")
    defer { try? FileManager.default.removeItem(at: url) }
    guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return codecs.mapValues { _ in false } }
    return codecs.keys.reduce(into: [:]) { result, codec in
        result[codec] = writer.canApply(outputSettings: outputSettings(codec, width: 2880, height: 1800), forMediaType: .video)
    }
}

func listWindows() -> [[String: Any]] {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return list.compactMap { info in
        guard let id = info[kCGWindowNumber as String] as? Int, let pid = info[kCGWindowOwnerPID as String] as? Int,
              let layer = info[kCGWindowLayer as String] as? Int, let raw = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: raw) else { return nil }
        return ["id": id, "pid": pid, "layer": layer, "owner": info[kCGWindowOwnerName as String] as? String ?? "",
                "title": info[kCGWindowName as String] as? String ?? "",
                "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
    }
}

func hostSeconds() -> Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

// One stream's writer. ScreenCaptureKit delivers a frame only when the window changes, so the file has a variable frame
// rate; at the stop the last frame is written again at the stop time, so every file runs to the same end. Its state changes
// only on its own queue.
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let plan: StreamPlan
    let windows: [SCWindow]
    let queue: DispatchQueue
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    let sizePt: CGSize, sizePx: CGSize, scale: Double
    var stream: SCStream!
    var firstFrame: CMTime?, wallClockStart: Date?, lastFrame: CMTime?, lastBuffer: CVPixelBuffer?
    var frames = 0, dropped = 0, idle = 0, blank = 0, suspended = 0
    var stopping = false
    var streamError: String?
    let onError: (String) -> Void

    init(plan: StreamPlan, windows: [SCWindow], filter: SCContentFilter, config: SCStreamConfiguration, sizePt: CGSize, scale: Double,
         url: URL, codec: String, onError: @escaping (String) -> Void) throws {
        self.plan = plan; self.windows = windows; self.sizePt = sizePt; self.scale = scale; self.onError = onError
        sizePx = CGSize(width: config.width, height: config.height)
        queue = DispatchQueue(label: "capture.\(plan.name)")
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        input = AVAssetWriterInput(mediaType: .video, outputSettings: outputSettings(codec, width: config.width, height: config.height))
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { throw NSError(domain: "capture", code: 1, userInfo: [NSLocalizedDescriptionKey: "writer-input"]) }
        writer.add(input)
        super.init()
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !stopping, buffer.isValid else { return }
        let info = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
        let status = (info?[.status] as? Int).flatMap(SCFrameStatus.init(rawValue:))
        switch status {
        case .complete: break
        case .idle: idle += 1; return
        case .blank: blank += 1; return
        case .suspended: suspended += 1; return
        default: return
        }
        guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(buffer)
        if firstFrame == nil {
            guard writer.startWriting() else { return report("writer: \(writer.error?.localizedDescription ?? "start failed")") }
            writer.startSession(atSourceTime: time)
            firstFrame = time
            wallClockStart = Date(timeIntervalSinceNow: time.seconds - hostSeconds())
        }
        guard input.isReadyForMoreMediaData, adaptor.append(pixels, withPresentationTime: time) else { dropped += 1; return }
        frames += 1; lastFrame = time; lastBuffer = pixels
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) { queue.async { self.report("stream: \(error.localizedDescription)") } }

    func report(_ message: String) {
        if streamError == nil { streamError = message; onError(message) }
    }

    func finish(at stop: CMTime) async {
        try? await stream.stopCapture()
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            queue.async {
                self.stopping = true
                if let last = self.lastFrame, let pixels = self.lastBuffer, stop > last, self.input.isReadyForMoreMediaData {
                    _ = self.adaptor.append(pixels, withPresentationTime: stop)
                }
                guard self.writer.status == .writing else { return done.resume() }
                self.input.markAsFinished()
                self.writer.finishWriting { done.resume() }
            }
        }
    }

    func summary() -> [String: Any] {
        queue.sync {
            var value: [String: Any] = [
                "name": plan.name, "file": "\(plan.name).mov", "composite": plan.composite,
                "windows": windows.map { window in
                    ["id": Int(window.windowID), "pid": Int(window.owningApplication?.processID ?? 0),
                     "app": window.owningApplication?.applicationName ?? "", "title": window.title ?? ""] as [String: Any]
                },
                "frames": frames, "droppedFrames": dropped, "idleFrames": idle, "blankFrames": blank, "suspendedFrames": suspended,
                "sizePt": ["width": sizePt.width, "height": sizePt.height],
                "sizePx": ["width": Int(sizePx.width), "height": Int(sizePx.height)], "scale": scale,
                "writer": writer.status == .completed ? "completed" : "status-\(writer.status.rawValue)",
            ]
            if let first = firstFrame, let wall = wallClockStart {
                value["firstFrameHostTime"] = first.seconds
                let format = ISO8601DateFormatter()
                format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                value["wallClockStart"] = format.string(from: wall)
            }
            if let error = streamError { value["error"] = error }
            return value
        }
    }
}

func even(_ value: Double) -> Int { max(2, Int((value / 2).rounded()) * 2) }

func makeRecorder(_ stream: StreamPlan, _ content: SCShareableContent, _ plan: Plan, onError: @escaping (String) -> Void) throws -> Recorder {
    let windows = try stream.windows.map { id -> SCWindow in
        guard let window = content.windows.first(where: { $0.windowID == id }) else {
            throw NSError(domain: "capture", code: 2, userInfo: [NSLocalizedDescriptionKey: "window-gone \(id)"])
        }
        return window
    }
    let config = SCStreamConfiguration()
    config.showsCursor = false
    config.capturesAudio = false
    config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(plan.fps))
    config.queueDepth = 8
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.captureResolution = .best
    config.ignoreShadowsSingleWindow = true
    config.ignoreShadowsDisplay = true
    let filter: SCContentFilter, sizePt: CGSize
    if stream.composite {
        let union = stream.cropFirst ? windows[0].frame : windows.dropFirst().reduce(windows[0].frame) { $0.union($1.frame) }
        guard let display = content.displays.first(where: { $0.frame.contains(union) }) else {
            throw NSError(domain: "capture", code: 3, userInfo: [NSLocalizedDescriptionKey: "composite-spans-displays \(stream.name)"])
        }
        if stream.followOwners {
            // DM1 pins the fixture and the renderer with explicit window ids. Include only those windows' owners so new
            // perch/ring panels stay in the recording after the host recreates them. The crop remains the first fixture.
            let pids = Set(windows.compactMap { $0.owningApplication?.processID })
            let apps = content.applications.filter { pids.contains($0.processID) }
            guard pids.count == 2, apps.count == 2 else {
                throw NSError(domain: "capture", code: 4, userInfo: [NSLocalizedDescriptionKey: "two-fixture-owners-required"])
            }
            filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
        } else { filter = SCContentFilter(display: display, including: windows) }
        config.sourceRect = union.offsetBy(dx: -display.frame.minX, dy: -display.frame.minY)
        sizePt = union.size
    } else {
        filter = SCContentFilter(desktopIndependentWindow: windows[0])
        sizePt = filter.contentRect.size
    }
    let scale = plan.scale ?? Double(filter.pointPixelScale)
    config.width = even(sizePt.width * scale)
    config.height = even(sizePt.height * scale)
    return try Recorder(plan: stream, windows: windows, filter: filter, config: config, sizePt: sizePt, scale: scale,
                        url: plan.out.appendingPathComponent("\(stream.name).mov"), codec: plan.codec, onError: onError)
}

func record(_ plan: Plan) async {
    guard codecAvailability()[plan.codec] == true else { fail("codec-unavailable", plan.codec) }
    for stream in plan.streams where FileManager.default.fileExists(atPath: plan.out.appendingPathComponent("\(stream.name).mov").path) {
        fail("file-exists", "\(stream.name).mov")
    }
    // Preflight never prompts. Without the grant, macOS would otherwise prompt mid-run on the first capture call.
    guard CGPreflightScreenCaptureAccess() else {
        fail("screen-recording-not-granted", "grant Screen & System Audio Recording to the app that started this process")
    }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    catch { fail("shareable-content", error.localizedDescription) }

    let stopSignal = DispatchSemaphore(value: 0)
    var stoppedBy: String?
    let lock = NSLock()
    func stop(_ reason: String) {
        lock.lock(); defer { lock.unlock() }
        if stoppedBy == nil { stoppedBy = reason; stopSignal.signal() }
    }
    var recorders: [Recorder] = []
    do { recorders = try plan.streams.map { try makeRecorder($0, content, plan) { _ in stop("error") } } }
    catch { fail("setup", error.localizedDescription) }

    for name in [SIGINT, SIGTERM] { signal(name, SIG_IGN) }
    let sources = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
        let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
        source.setEventHandler { stop("signal") }
        source.resume()
        return source
    }
    var started: [Recorder] = []
    for recorder in recorders {
        do { try await recorder.stream.startCapture(); started.append(recorder) }
        catch { recorder.report("start: \(error.localizedDescription)"); stop("error"); break }
    }
    if started.count == recorders.count { emit(["ok": true, "event": "ready"]) }
    if let seconds = plan.duration { DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { stop("duration") } }
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().async { stopSignal.wait(); done.resume() }
    }
    sources.forEach { $0.cancel() }
    let stopTime = CMClockGetTime(CMClockGetHostTimeClock())
    for recorder in started { await recorder.finish(at: stopTime) }
    let streams = recorders.map { $0.summary() }
    let sync: [String: Any] = [
        "version": 1, "codec": plan.codec, "fps": plan.fps, "stoppedBy": stoppedBy ?? "error", "hostClock": "CMClockGetHostTimeClock",
        "stopHostTime": stopTime.seconds, "streams": streams,
    ]
    let data = try! JSONSerialization.data(withJSONObject: sync, options: [.prettyPrinted, .sortedKeys])
    do { try data.write(to: plan.out.appendingPathComponent("sync.json")) } catch { fail("sync-write", error.localizedDescription) }
    let failed = streams.contains { $0["error"] != nil || ($0["frames"] as? Int ?? 0) == 0 }
    emit(["ok": !failed, "stoppedBy": stoppedBy ?? "error", "sync": plan.out.appendingPathComponent("sync.json").path])
    exit(failed ? 1 : 0)
}

let args = CommandLine.arguments
switch (args.count, args.count > 1 ? args[1] : "") {
case (3, "record"):
    let plan = readPlan(args[2])
    Task { await record(plan) }
    dispatchMain()
case (3, "validate"):
    let plan = readPlan(args[2])
    emit(["ok": true, "streams": plan.streams.count, "scale": plan.scale as Any? ?? NSNull(), "captureStarted": false])
case (2, "list"): emit(["ok": true, "windows": listWindows()])
case (2, "codecs"): emit(codecAvailability().reduce(into: ["ok": true] as [String: Any]) { $0[$1.key] = $1.value })
case (2, "request-permission"): emit(["ok": true, "granted": CGRequestScreenCaptureAccess()])
default: fail("usage")
}
