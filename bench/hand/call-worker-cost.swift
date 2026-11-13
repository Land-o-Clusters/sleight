// Headless worker-only endpoint measurement. The private pipes belong to this runner.
import Foundation
import Darwin
import QuartzCore
import CoreAudio
import CryptoKit

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 6, let seconds = Double(args[2]), (1...120).contains(seconds),
    let rounds = Int(args[3]), (1...3).contains(rounds), let period = Double(args[4]), (0.1...2).contains(period),
    ["requests", "blocked", "watch", "delivery"].contains(args[1]) else { exit(64) }
let binarySha256 = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: args[0]))).map { String(format: "%02x", $0) }.joined()
func emit(_ row: [String: Any]) {
    var row = row; row["binarySha256"] = binarySha256; row["sourceSha256"] = args[5]
    print(String(data: try! JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]), encoding: .utf8)!); fflush(stdout)
}
func processCount() -> Int {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain), size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return -1 }
    return Int(size) / MemoryLayout<AudioObjectID>.size
}
func usage(_ pid: pid_t) -> rusage_info_v2 {
    var info = rusage_info_v2()
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
    }
    precondition(status == 0, "worker rusage unavailable")
    return info
}
var timebase = mach_timebase_info_data_t()
precondition(mach_timebase_info(&timebase) == KERN_SUCCESS)
let secondsPerTick = Double(timebase.numer) / Double(timebase.denom) / 1e9
final class WatchState: @unchecked Sendable {
    private let lock = NSLock()
    private var stopping = false, notifications = 0
    private var replies: [(Double, UInt8)] = [], events: [[String: Any]] = []
    func request(_ input: FileHandle) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if stopping { return false }; input.write(Data([4])); return true
    }
    func received(_ reply: UInt8) { lock.lock(); notifications += 1; replies.append((CACurrentMediaTime(), reply)); lock.unlock() }
    func event(_ row: [String: Any]) { lock.lock(); events.append(row); lock.unlock() }
    func delivery(_ began: Double, _ pid: pid_t) -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        let notification = events.first { ($0["event"] as? String) == "notification" && $0["processList"] as? Bool == true && ($0["time"] as? Double ?? 0) >= began }
        let census = events.first { ($0["event"] as? String) == "census" && ($0["time"] as? Double ?? 0) >= began && ($0["pids"] as? [Int] ?? []).contains(Int(pid)) }
        let response = census.flatMap { row in replies.first { $0.0 >= (row["time"] as! Double) && $0.1 < 2 } }
        return ["notificationMs": notification.map { (($0["time"] as! Double) - began) * 1000 } as Any? ?? NSNull(),
            "censusMs": census.map { (($0["time"] as! Double) - began) * 1000 } as Any? ?? NSNull(),
            "replyMs": response.map { ($0.0 - began) * 1000 } as Any? ?? NSNull(), "afplayPID": pid]
    }
    func stop(_ input: FileHandle) { lock.lock(); stopping = true; input.closeFile(); lock.unlock() }
    var count: Int { lock.lock(); defer { lock.unlock() }; return notifications }
}
let watching = ["watch", "delivery"].contains(args[1])
for round in 1...(args[1] == "delivery" ? 1 : rounds) {
    let worker = Process(), input = Pipe(), output = Pipe(), diagnostics = Pipe()
    worker.executableURL = URL(fileURLWithPath: args[0]); worker.arguments = ["--stage-call-worker"]
    worker.standardInput = input; worker.standardOutput = output
    worker.standardError = args[1] == "delivery" ? diagnostics.fileHandleForWriting : FileHandle.nullDevice
    let setupBegan = CACurrentMediaTime(), setupUTC = ISO8601DateFormatter().string(from: Date()), objects = processCount()
    try worker.run()
    input.fileHandleForReading.closeFile(); output.fileHandleForWriting.closeFile()
    func transact(_ byte: UInt8) -> UInt8 {
        input.fileHandleForWriting.write(Data([byte]))
        var ready = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
        precondition(poll(&ready, 1, 1000) == 1 && ready.revents & Int16(POLLIN) != 0, "worker 1 s production reply deadline")
        let reply = output.fileHandleForReading.readData(ofLength: 1)
        precondition(reply.count == 1 && reply[0] <= 2, "invalid worker reply")
        return reply[0]
    }
    let initial = transact(watching ? 3 : 1), setupEnded = CACurrentMediaTime()
    precondition(initial == 0 || initial == 1, "initial census and subscription must succeed")
    let setupMs = (setupEnded - setupBegan) * 1000
    emit(["event": "setup", "round": round, "mode": args[1], "startUTC": setupUTC, "startMonotonic": setupBegan,
        "endMonotonic": setupEnded, "setupMs": setupMs, "processObjects": objects, "initial": initial,
        "under250ms": setupMs < 250, "underProductionDeadline": setupMs < 1000])
    let state = WatchState(), finished = DispatchSemaphore(value: 0)
    if args[1] == "delivery" {
        diagnostics.fileHandleForWriting.closeFile()
        DispatchQueue.global(qos: .utility).async {
            var buffer = Data(), byte: UInt8 = 0
            while read(diagnostics.fileHandleForReading.fileDescriptor, &byte, 1) == 1 {
                if byte == 10 {
                    if let row = try? JSONSerialization.jsonObject(with: buffer) as? [String: Any] { state.event(row) }
                    buffer.removeAll(keepingCapacity: true)
                } else { buffer.append(byte) }
            }
        }
    }
    if watching {
        DispatchQueue.global(qos: .utility).async {
            while state.request(input.fileHandleForWriting) {
                var reply: UInt8 = 255
                if read(output.fileHandleForReading.fileDescriptor, &reply, 1) != 1 { break }
                precondition(reply < 2)
                state.received(reply)
            }
            finished.signal()
        }
    }
    Thread.sleep(forTimeInterval: 0.5)
    if args[1] == "delivery" {
        let file = URL(fileURLWithPath: args[0]).deletingLastPathComponent().appendingPathComponent("silence.wav")
        var wav = Data()
        func text(_ value: String) { wav.append(Data(value.utf8)) }
        func word<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) } }
        text("RIFF"); word(UInt32(36 + 88200)); text("WAVEfmt "); word(UInt32(16)); word(UInt16(1)); word(UInt16(1))
        word(UInt32(44100)); word(UInt32(88200)); word(UInt16(2)); word(UInt16(16)); text("data"); word(UInt32(88200))
        wav.append(Data(repeating: 0, count: 88200)); try wav.write(to: file)
        var passed = 0
        for trial in 1...20 {
            let player = Process(); player.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
            player.arguments = ["-v", "0", file.path]; player.standardOutput = FileHandle.nullDevice; player.standardError = FileHandle.nullDevice
            let began = CACurrentMediaTime(); try player.run()
            let deadline = began + 0.25
            while CACurrentMediaTime() < deadline {
                if state.delivery(began, player.processIdentifier)["replyMs"] is Double { break }
                Thread.sleep(forTimeInterval: 0.001)
            }
            var row = state.delivery(began, player.processIdentifier)
            let ok = (row["notificationMs"] as? Double).map { $0 <= 250 } == true && (row["replyMs"] as? Double).map { $0 <= 250 } == true
            if ok { passed += 1 }; player.waitUntilExit()
            precondition(player.terminationStatus == 0)
            row["event"] = "delivery"; row["trial"] = trial; row["passed"] = ok; row["startMonotonic"] = began
            emit(row); Thread.sleep(forTimeInterval: 0.1)
        }
        state.stop(input.fileHandleForWriting)
        precondition(finished.wait(timeout: .now() + 3) == .success)
        worker.waitUntilExit(); precondition(worker.terminationStatus == 0)
        emit(["event": "delivery-summary", "passed": passed, "trials": 20, "exit": worker.terminationStatus,
            "processObjectsBefore": objects, "processObjectsAfter": processCount(), "windows": 0, "captures": 0])
        precondition(passed == 20, "process-list notification and fresh reading must arrive within 250 ms in all trials")
        continue
    }
    let before = usage(worker.processIdentifier), start = CACurrentMediaTime()
    var replies = 0, next = start + period
    while true {
        let now = CACurrentMediaTime(), end = start + seconds
        if now >= end { break }
        if args[1] == "requests" && next < end {
            Thread.sleep(forTimeInterval: max(0, next - now)); _ = transact(1); replies += 1; next += period
        } else { Thread.sleep(forTimeInterval: max(0, end - now)) }
    }
    let after = usage(worker.processIdentifier), elapsed = CACurrentMediaTime() - start
    precondition(before.ri_proc_start_abstime == after.ri_proc_start_abstime)
    state.stop(input.fileHandleForWriting)
    if watching { precondition(finished.wait(timeout: .now() + 3) == .success, "worker observer EOF") }
    worker.waitUntilExit(); output.fileHandleForReading.closeFile()
    precondition(worker.terminationStatus == 0, "worker EOF cleanup")
    let result: [String: Any] = ["round": round, "mode": args[1], "seconds": elapsed, "period": period,
        "initial": initial, "requests": replies, "observationReplies": state.count, "exit": worker.terminationStatus,
        "beforeUserS": Double(before.ri_user_time) * secondsPerTick,
        "beforeSystemS": Double(before.ri_system_time) * secondsPerTick,
        "afterUserS": Double(after.ri_user_time) * secondsPerTick,
        "afterSystemS": Double(after.ri_system_time) * secondsPerTick,
        "cpuS": Double(after.ri_user_time - before.ri_user_time + after.ri_system_time - before.ri_system_time) * secondsPerTick,
        "packageWakeups": after.ri_pkg_idle_wkups - before.ri_pkg_idle_wkups,
        "interruptWakeups": after.ri_interrupt_wkups - before.ri_interrupt_wkups,
        "windows": 0, "captures": 0]
    emit(result)
}
