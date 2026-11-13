import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const mutations = {
  'no-backoff': ['backoff = min(30, backoff * 2)', 'backoff = 0.5'],
  'blocking-prefetch': ['let began = CACurrentMediaTime()\n        defer { prefetchAddedMs', 'let began = CACurrentMediaTime(); usleep(10_000)\n        defer { prefetchAddedMs'],
  'invalid-is-quiet': ['case 2: return unavailable', 'case 2: return (true, "quiet", "quiet")'],
  'forget-unreaped': ['// Retain ownership and block replacement', 'pid = nil\n        // Retain ownership and block replacement'],
  'pending-hides': ['lastSuccessfulInput == true\n    }', 'pending || lastSuccessfulInput == true\n    }'],
  'timeout-hides': ['// A failure neither clears', 'if result.state == "timeout" { lastSuccessfulInput = true }\n        // A failure neither clears'],
  'unknown-hides': ['lastSuccessfulInput == true\n    }', 'lastSuccessfulInput != false\n    }'],
  'expiry-hides': ['lastSuccessfulInput == true\n    }', 'lastSuccessfulInput == true || successfulSampled.isFinite && now - successfulSampled > 1\n    }'],
  'failure-clears-live': ['// A failure neither clears', 'lastSuccessfulInput = false\n        // A failure neither clears'],
  'live-does-not-hide': ['lastSuccessfulInput = true; successfulSampled', 'lastSuccessfulInput = false; successfulSampled'],
  'no-worker-deadline': ['let left = deadline.map { $0 - (CACurrentMediaTime() - began) } ?? Double.infinity', 'let left = 20.0'],
  'respawn-each-query': ['let began = CACurrentMediaTime()\n        if input < 0', 'let began = CACurrentMediaTime(); stop()\n        if input < 0'],
  'small-skips-monitor': ['return stageCall.active(now)', 'return false'],
  'inherits-consent': ['posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) == 0', 'posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)) == 0'],
  'worker-ignores-eof': ['if count == 0 { return 0 }', 'if count == 0 { usleep(1000); continue }'],
  'no-self-deadline': ['alarm(2); defer { alarm(0) }', ''],
  'ignore-observation': ['if !observing && !pending && now - requested >= 0.5', 'if !pending && now - requested >= 0.5'],
};
if (process.env.CHV2X_BROKEN) {
  const pair = mutations[process.env.CHV2X_BROKEN];
  assert.ok(pair && source.includes(pair[0]), 'mutation must change production code');
  source = source.replace(pair[0], pair[1]);
}
const monitorSource = source.slice(source.indexOf('final class StageCallMonitor {'), source.indexOf('func stageVisibilityStatus('));
const workerSource = source.slice(source.indexOf('func stageCallQuery('), source.indexOf('final class StageCallMonitor {'))
  .replace('AudioObjectAddPropertyListenerBlock(object, &address, queue, block)', 'noErr')
  .replace('AudioObjectRemovePropertyListenerBlock(object, &address, queue, block)', 'noErr');
const folder = realpathSync(trackTemp(mkdtempSync(join(tmpdir(), 'sleight-call-monitor-'))));
let binary;
function host() {
  if (binary) return binary;
  const file = join(folder, 'call.swift'), output = join(folder, 'call');
  const slotSource = source.slice(source.indexOf('// BEGIN STAGE SLOT'), source.indexOf('// END STAGE SLOT'));
  const admission = source.slice(source.indexOf('    func yieldStageSlot()'), source.indexOf('    func releaseUnusedStageSlot('));
  const legacy = source.slice(source.indexOf('    func legacyCallBlocked()'), source.indexOf('    func dissolve(_ event: RingEvent)', source.indexOf('final class PerchHost {')));
  writeFileSync(file, `import Foundation
import CoreAudio
import QuartzCore
import Carbon
import Darwin
var owned: Set<pid_t> = [], trackAllowed = true, blockReap = false
var warnings: [String] = []
func spriteTrack(_ pid: pid_t) -> Bool { if trackAllowed { owned.insert(pid) }; return trackAllowed }
func spriteUntrack(_ pid: pid_t) { owned.remove(pid) }
func spriteWarning(_ text: String) { warnings.append(text) }
func waitpid(_ pid: pid_t, _ status: UnsafeMutablePointer<Int32>?, _ options: Int32) -> pid_t {
    if blockReap { return 0 }; return Darwin.waitpid(pid, status, options)
}
let args = Array(CommandLine.arguments.dropFirst())
struct FakeAudio {
    func processes() -> [UInt32]? {
        if args.contains("--hang-audio") { sleep(10) }
        return fcntl(19, F_GETFD) == -1 ? [1] : nil
    }
    func word(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) -> UInt32? { args.contains("--active") ? 1 : 0 }
}
enum NarrationAudio { static let system = FakeAudio() }
${workerSource}
${monitorSource}
if args.first == "--stage-call-worker" { exit(stageCallWorkerMain()) }
if args.first == "--owner-worker" {
    let inherited = open("/dev/null", O_RDONLY); precondition(inherited >= 0)
    precondition(dup2(inherited, 19) == 19); close(inherited)
    let worker = StageCallWorker()
    let reply = worker.query()
    print("\\(worker.pid ?? -1) \\(reply.quiet ? 1 : 0)"); fflush(stdout)
    var command: UInt8 = 0; precondition(read(0, &command, 1) == 1)
    // Abrupt parent death must close the request pipe even though no stop()/deinit executes.
    raise(SIGKILL); _exit(3)
}
if args.first == "--reply" {
    while true {
        var request: UInt8 = 0
        if read(0, &request, 1) != 1 { exit(0) }
        if args[1] == "hang" { sleep(10); exit(0) }
        if args[1] == "signal" { raise(SIGTERM); exit(0) }
        if args[1] == "quiet-then-exit" {
            var response: UInt8 = 0
            _ = write(1, &response, 1); exit(0)
        }
        var response = UInt8(args[1])!
        if write(1, &response, 1) != 1 { exit(2) }
    }
}
func complete(_ monitor: StageCallMonitor, _ state: String, _ at: Double) {
    monitor.complete((state == "quiet", state, state == "input-active" ? "microphone input active" : state), at: at, elapsedMs: 0)
}
func spin(_ until: () -> Bool, seconds: Double) {
    let end = CACurrentMediaTime() + seconds
    while !until() && CACurrentMediaTime() < end { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.002)) }
}
struct PerchEvent {}
struct LegacyRuntime {
    var asleep = false, shown = false, received = 0
    mutating func hide(_ now: Double, _ why: String) -> [Int] { shown = false; return [] }
    mutating func receive(_ event: PerchEvent, now: Double, env: Int) -> [Int] { shown = true; received += 1; return [] }
    mutating func observe(_ now: Double, env: Int) -> [Int] { [] }
    mutating func observeCall(now: Double, env: Int, visible: Bool) -> [Int] { observe(now, env: env) }
}
struct LegacyPanel { var isVisible = false }
class LegacyFixture {
    var panel: LegacyPanel?
    var stageCall = StageCallMonitor(), runtime = LegacyRuntime(), now = 100.0
    var stage = SlotRuntime()
    var active = true, stageActive = false, legacyCallEvent: PerchEvent? = PerchEvent(), legacyCallAt = 100.0
    var lastHideReason: String? = "call", released = 0, environment = 0
    func release() { released += 1 }; func closeBubble() {}; func schedule() {}; func perform(_ effects: [Int]) {}
${legacy}
}
${slotSource}
struct StageWorld {
    var call = false, stopped = false, inputAge = 20.0, person: CGRect? = .zero, displayID: String? = "1"
    var base = SlotBase()
}
struct SlotBase { var window = CGRect(x: 0, y: 0, width: 100, height: 100) }
struct SlotOptions { var size = "stage", attention = false }
struct SlotRuntime {
    var hideReasonCounts: [String: Int] = [:]
    var options = SlotOptions()
    mutating func hide(_ reason: String, immediate: Bool, at: Double) -> [Int] { [] }
}
struct SlotArt { var file: String? = "fixture" }
struct SlotFrame { var stage: [String: SlotArt]? = ["stage-lie": SlotArt()] }
struct SlotCharacter { var frame = SlotFrame() }
class AdmissionFixture {
    var stageSlot = StageSlot(root: ${JSON.stringify(join(folder, 'slots'))}), stage = SlotRuntime()
    var loaded: SlotCharacter? = SlotCharacter(), now = 0.0, releases = 0
    func release() { releases += 1 }
${admission}
}
let scenario = args.first ?? ""
var result: [String: Any] = ["windowsCreated": 0]
switch scenario {
case "startup":
    let monitor = StageCallMonitor()
    precondition(!monitor.isActive(0), "no successful reading means shown")
    monitor.pending = true; monitor.requested = 0
    precondition(!monitor.isActive(100), "pending cannot hide at startup")
    let snapshot = monitor.snapshot(100)
    precondition(snapshot["state"] as? String == "pending")
    precondition(snapshot["lastSuccessfulState"] is NSNull)
    result["startupShown"] = true
case "states":
    for prior in ["none", "quiet", "input-active"] {
        let monitor = StageCallMonitor()
        if prior != "none" { complete(monitor, prior, 100) }
        let active = prior == "input-active"
        for state in ["pending", "timeout", "unavailable", "error"] {
            if state == "pending" { monitor.pending = true; monitor.requested = 101 }
            else { complete(monitor, state, 102) }
            precondition(monitor.isActive(200) == active, prior + " must survive " + state)
            let snapshot = monitor.snapshot(200)
            precondition(snapshot["state"] as? String == state)
            if state != "pending" {
                precondition(snapshot["sampleState"] as? String == state && !monitor.quiet)
                precondition(snapshot["reason"] as? String == state)
            }
            if prior == "none" { precondition(snapshot["lastSuccessfulState"] is NSNull) }
            else { precondition(snapshot["lastSuccessfulState"] as? String == prior) }
        }
        monitor.complete((true, "unavailable", "unavailable"), at: 201, elapsedMs: 0)
        precondition(monitor.isActive(202) == active, "an invalid quiet flag is not a reading")
        complete(monitor, "quiet", 203); precondition(!monitor.isActive(204))
        complete(monitor, "input-active", 205); precondition(monitor.isActive(206))
    }
    result["retainedCases"] = 12
case "backoff":
    let monitor = StageCallMonitor(); var delays: [Double] = []
    for index in 0..<8 { complete(monitor, "timeout", Double(index)); delays.append(monitor.retryAt - monitor.sampled) }
    precondition(delays == [0.5, 1, 2, 4, 8, 16, 30, 30])
    complete(monitor, "quiet", 10); precondition(monitor.backoff == 0.5)
    result["delays"] = delays
case "small":
    let host = LegacyFixture(); host.stageCall.requested = 1000
    host.stageCall.pending = true
    host.observeLegacyCall(); precondition(host.runtime.shown, "small pending stays shown")
    complete(host.stageCall, "quiet", 100); host.observeLegacyCall(); precondition(host.runtime.shown)
    complete(host.stageCall, "input-active", 100); host.observeLegacyCall()
    precondition(!host.runtime.shown && host.lastHideReason == "call", "small active microphone is hidden")
    complete(host.stageCall, "timeout", 100); host.observeLegacyCall(); precondition(!host.runtime.shown)
    host.now = 400; host.observeLegacyCall(); precondition(!host.runtime.shown, "live reading has no expiry")
    complete(host.stageCall, "quiet", 400); host.observeLegacyCall(); precondition(host.runtime.shown && host.runtime.received == 2)
    host.now = 700; host.observeLegacyCall()
    precondition(host.legacyCallEvent == nil && !host.runtime.shown, "microphone callbacks cannot resurrect an expired event")
    result["transitions"] = 7
case "slot":
    let host = AdmissionFixture(); var world = StageWorld()
    precondition(host.stageAdmission(world) && host.stageSlot.display == "1")
    world.stopped = true
    precondition(!host.stageAdmission(world) && host.stageSlot.display == nil && host.releases == 1)
    world.stopped = false
    precondition(host.stageAdmission(world) && host.stageSlot.display == "1" && host.stage.options.size == "stage", "call hide must re-admit the configured stage rung")
    host.stageSlot.release(); result["readmitted"] = true
case "worker":
    let fd = open("/dev/null", O_RDONLY); precondition(fd >= 0 && dup2(fd, 19) == 19)
    let worker = StageCallWorker()
    // 301 polls span a simulated 60 seconds at the animating interval. No wall-clock wait or real audio.
    let monitor = StageCallMonitor()
    for tick in 0...300 {
        let now = Double(tick) * 0.2, reply = worker.query()
        monitor.complete(reply, at: now, elapsedMs: 0)
        precondition(reply.quiet && reply.state == "quiet" && monitor.quiet, "successful metadata reply with no inherited consent descriptor")
        precondition(!monitor.isActive(now))
    }
    precondition(worker.spawns == 1 && owned.count == 1, "persistent worker must reuse its child")
    result["spawns"] = worker.spawns; result["simulatedSeconds"] = 60; result["queries"] = 301
    worker.stop(); precondition(owned.isEmpty && worker.pid == nil)
    close(19); close(fd)
case "deadline":
    let worker = StageCallWorker()
    let monitor = StageCallMonitor()
    monitor.complete(worker.query(arguments: ["--reply", "0"]), at: 0, elapsedMs: 0)
    precondition(!monitor.isActive(0))
    worker.stop()
    let began = CACurrentMediaTime()
    let failed = worker.query(arguments: ["--reply", "hang"])
    let elapsed = CACurrentMediaTime() - began
    precondition(failed.state == "timeout" && !failed.quiet && elapsed >= 0.95 && elapsed < 1.3, "hung request deadline")
    monitor.complete(failed, at: 1, elapsedMs: elapsed * 1000)
    precondition(!monitor.isActive(1), "a hung source preserves shown")
    precondition(owned.isEmpty)
    precondition(worker.query(arguments: ["--reply", "0"]).quiet && worker.spawns == 3, "replace hung child")
    worker.stop(); result["timeoutSeconds"] = elapsed; result["spawns"] = worker.spawns
case "dead-source":
    let worker = StageCallWorker(), monitor = StageCallMonitor()
    monitor.complete(worker.query(arguments: ["--reply", "quiet-then-exit"]), at: 0, elapsedMs: 0)
    precondition(!monitor.isActive(0))
    usleep(20_000)
    let dead = worker.query()
    precondition(dead.state == "unavailable" && worker.pid == nil)
    monitor.complete(dead, at: 1, elapsedMs: 0)
    precondition(!monitor.isActive(1), "a dead source preserves shown")
    monitor.complete(worker.query(), at: 2, elapsedMs: 0)
    precondition(monitor.quiet && worker.spawns == 2, "dead child is replaced")
    worker.stop(); precondition(owned.isEmpty); result["spawns"] = worker.spawns
case "errors":
    var states: [String] = []
    for value in ["0", "1", "2", "255", "signal"] {
        let worker = StageCallWorker(); states.append(worker.query(arguments: ["--reply", value]).state); worker.stop()
    }
    precondition(states == ["quiet", "input-active", "unavailable", "unavailable", "unavailable"])
    let worker = StageCallWorker(); trackAllowed = false
    precondition(worker.query(arguments: ["--reply", "hang"]).state == "unavailable")
    precondition(worker.query(executable: "/absent/sleight").state == "unavailable")
    precondition(owned.isEmpty); result["states"] = states
case "cleanup":
    let worker = StageCallWorker(); blockReap = true
    precondition(worker.query(arguments: ["--reply", "hang"], deadline: 0.01).state == "timeout")
    precondition(worker.pid != nil && owned.count == 1)
    precondition(worker.query().reason == "microphone metadata child cleanup pending" && worker.spawns == 1)
    blockReap = false; usleep(20_000)
    precondition(worker.query().quiet && worker.spawns == 2)
    worker.stop(); precondition(owned.isEmpty)
    result["blockedSpawns"] = 1
case "eof":
    let worker = Process(), requests = Pipe()
    worker.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); worker.arguments = ["--stage-call-worker"]
    worker.standardInput = requests; worker.standardOutput = FileHandle.nullDevice; worker.standardError = FileHandle.nullDevice
    try! worker.run(); requests.fileHandleForWriting.closeFile()
    spin({ !worker.isRunning }, seconds: 2)
    let exited = !worker.isRunning
    if !exited { kill(worker.processIdentifier, SIGKILL) }
    worker.waitUntilExit()
    precondition(exited && worker.terminationStatus == 0, "request-pipe EOF must exit idle worker with status zero")
    result["exit"] = worker.terminationStatus
case "parent-loss":
    let owner = Process(), output = Pipe(), control = Pipe()
    owner.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); owner.arguments = ["--owner-worker"]
    owner.standardInput = control; owner.standardOutput = output; owner.standardError = FileHandle.nullDevice
    try! owner.run()
    var ready = pollfd(fd: output.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0)
    precondition(poll(&ready, 1, 2000) == 1)
    let bytes = output.fileHandleForReading.availableData
    let fields = String(data: bytes, encoding: .utf8)!.split(separator: " ")
    let worker = pid_t(fields.first ?? "-1") ?? -1
    if worker <= 0 || fields.last?.trimmingCharacters(in: .whitespacesAndNewlines) != "1" {
        control.fileHandleForWriting.write(Data([1])); owner.waitUntilExit()
        preconditionFailure("production spawner must close unrelated descriptors before parent-loss observation")
    }
    let queue = kqueue(); precondition(queue >= 0); defer { close(queue) }
    var change = kevent(ident: UInt(worker), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ENABLE | EV_ONESHOT), fflags: UInt32(NOTE_EXIT), data: 0, udata: nil)
    precondition(kevent(queue, &change, 1, nil, 0, nil) == 0)
    control.fileHandleForWriting.write(Data([1])); owner.waitUntilExit()
    precondition(owner.terminationReason == .uncaughtSignal && owner.terminationStatus == SIGKILL)
    var event = kevent(), limit = timespec(tv_sec: 2, tv_nsec: 0)
    let exited = kevent(queue, nil, 0, &event, 1, &limit) == 1 && event.ident == UInt(worker) && event.fflags & UInt32(NOTE_EXIT) != 0
    if !exited {
        kill(worker, SIGKILL)
        var cleanup = timespec(tv_sec: 2, tv_nsec: 0)
        precondition(kevent(queue, nil, 0, &event, 1, &cleanup) == 1, "test must collect the orphan exit event on failure")
    }
    precondition(exited, "worker must exit on killed parent pipe EOF without stop or an orphan")
    result["parentSignal"] = SIGKILL; result["workerExitObserved"] = true
case "self-deadline":
    let worker = StageCallWorker(), began = CACurrentMediaTime()
    let reply = worker.query(arguments: ["--stage-call-worker", "--hang-audio"], deadline: 4)
    let elapsed = CACurrentMediaTime() - began
    precondition(!reply.quiet && reply.state == "unavailable" && elapsed < 2.8, "child self deadline survives parent loss")
    worker.stop(); precondition(owned.isEmpty); result["seconds"] = elapsed
case "expiry":
    let monitor = StageCallMonitor(); var changes = 0
    monitor.changed = { changes += 1 }
    complete(monitor, "quiet", CACurrentMediaTime()); let first = changes
    spin({ changes > first }, seconds: 1.5)
    precondition(changes == first && !monitor.isActive(CACurrentMediaTime()), "no expiry wake or hide")
    for time in [100.0, 1000, 100000] { precondition(!monitor.isActive(time)) }
    complete(monitor, "input-active", 100)
    for time in [99.0, 100, 1000, 100000] { precondition(monitor.isActive(time), "live reading never expires") }
    complete(monitor, "quiet", 100001); precondition(!monitor.isActive(100002))
    result["changes"] = changes
case "async":
    let monitor = StageCallMonitor(); var costs: [Double] = []
    for _ in 0..<100 {
        let began = CACurrentMediaTime(); monitor.prefetch(began); costs.append((CACurrentMediaTime() - began) * 1000)
    }
    precondition(monitor.pending && !monitor.isActive(CACurrentMediaTime()))
    spin({ !monitor.pending }, seconds: 1.3)
    precondition(!monitor.pending && monitor.quiet && stageCallWorker.spawns == 1)
    precondition(costs.allSatisfy { $0 < 5 }); stageCallWorker.stop()
    result["maxEnqueueMs"] = costs.max()!
case "subscribed-idle":
    let monitor = StageCallMonitor()
    monitor.prefetch(CACurrentMediaTime())
    spin({ !monitor.pending }, seconds: 1.3)
    precondition(!monitor.pending && monitor.quiet && stageCallWorker.spawns == 1)
    let sampled = monitor.sampled
    for _ in 0..<20 {
        monitor.prefetch(CACurrentMediaTime())
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    precondition(!monitor.pending && monitor.sampled == sampled && stageCallWorker.spawns == 1,
        "parked prefetches must keep one blocked subscription, with no periodic request or completion")
    stageCallWorker.stop(); result["idleCompletions"] = 0; result["prefetches"] = 20
default: fatalError("unknown scenario")
}
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', output],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr); binary = output; return binary;
}
for (const scenario of ['startup', 'states', 'backoff', 'small', 'slot', 'worker', 'deadline', 'dead-source', 'errors', 'cleanup', 'self-deadline', 'eof', 'parent-loss', 'expiry', 'async', 'subscribed-idle']) {
  test(`microphone safety: ${scenario}`, { skip: process.platform !== 'darwin' }, t => {
    const result = spawnSync(host(), [scenario], { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const row = JSON.parse(result.stdout); assert.equal(row.windowsCreated, 0); t.diagnostic(JSON.stringify(row));
    if (scenario === 'worker') assert.ok(row.spawns / row.simulatedSeconds < 0.1);
  });
}
test('production stage and legacy apply paths consult the monitor before showing', () => {
  assert.match(source, /call: stageCall\.active\(at\)/);
  assert.match(source, /"callMonitor": stageCall\.snapshot\(now\)/);
  const perform = source.slice(source.indexOf('    func performStage('), source.indexOf('    // Perch mode:'));
  assert.match(perform, /stageCallApply\(effects, runtime: &stage, active: \{ stageCall\.active\(now\) \}/);
  const legacy = source.slice(source.indexOf('    func perform(_ effects: [(Double, PerchEffect)])'), source.indexOf('    // One one-shot wake'));
  assert.match(legacy, /legacyCallBlocked\(\).*hideLegacyCall/);
});
