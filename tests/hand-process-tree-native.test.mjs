import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import * as live from '../bench/hand/stage-live.mjs';

test('kernel tree meter retains a child cost after reaping and includes a live child without creating windows',
  { skip: process.platform !== 'darwin' }, t => {
    const source = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
    const begin = source.indexOf('// BEGIN PROCESS TREE COST'), end = source.indexOf('// END PROCESS TREE COST');
    assert.ok(begin >= 0 && end > begin, 'the baseline does not meter child resource usage');
    const product = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
    const instrumented = process.env.CA6F_BROKEN_VARIANT === 'tree-no-query-spawns' ? product : live.stageCostSource(product);
    const query = instrumented.slice(instrumented.indexOf('func stageCallQuery('), instrumented.indexOf('final class StageCallMonitor {'));
    let meter = source.slice(begin, end);
    if (process.env.CHV4F_TREE_BROKEN === 'charge-decode-to-worker') {
      const before = 'Double(info.ri_user_time + info.ri_system_time) * secondsPerTick';
      assert.ok(meter.includes(before)); meter = meter.replace(before, 'Double(value.childrenCpu) * secondsPerTick');
    }
    if (process.env.CHV4F_TREE_BROKEN === 'omit-worker') {
      const before = '"microphoneWorker": worker as Any? ?? NSNull()';
      assert.ok(meter.includes(before)); meter = meter.replace(before, '"microphoneWorker": NSNull()');
    }
    if (process.env.CA6F_BROKEN_VARIANT === 'tree-parent-only') {
      const original = 'let childCpu = after.ri_child_user_time + after.ri_child_system_time + cpu';
      assert.ok(meter.includes(original)); meter = meter.replace(original, 'let childCpu: UInt64 = 0');
    }
    const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-tree-cost-'))));
    const main = join(root, 'main.swift'), binary = join(root, 'meter');
    writeFileSync(main, 'import Foundation\nimport Darwin\nimport QuartzCore\nimport CoreAudio\n' + meter + `
func spriteTrack(_ pid: pid_t) -> Bool { true }
func spriteUntrack(_ pid: pid_t) {}
struct FakeAudio {
    func processes() -> [UInt32]? { [] }
    func word(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) -> UInt32? { 0 }
}
enum NarrationAudio { static let system = FakeAudio() }
${query}
let args = Array(CommandLine.arguments.dropFirst())
if args == ["--stage-call-query"] { exit(stageCallQueryMain()) }
if args == ["--stage-call-worker"] { exit(stageCallWorkerMain()) }
if args == ["--burn"] {
    var before = rusage(); getrusage(RUSAGE_SELF, &before)
    var sum = 0.0
    while true {
        for i in 0..<10000 { sum += sqrt(Double(i + 1)) }
        var now = rusage(); getrusage(RUSAGE_SELF, &now)
        let used = Double(now.ru_utime.tv_sec - before.ru_utime.tv_sec) + Double(now.ru_utime.tv_usec - before.ru_utime.tv_usec) / 1e6
        if used >= 0.12 { break }
    }
    usleep(100_000); print(sum); exit(0)
}
let first = stageBenchProcessTree()!
let child = Process(); child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]); child.arguments = ["--burn"]
child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
try child.run()
let live = stageBenchProcessTree()!
precondition((live["liveChildren"] as! Int) == 1, "live tree: " + String(describing: live))
child.waitUntilExit(); precondition(child.terminationStatus == 0)
precondition(stageCallQuery().quiet)
let beforeIdle = stageBenchProcessTree()!
usleep(1_000_000)
let afterIdle = stageBenchProcessTree()!
let workerBefore = beforeIdle["microphoneWorker"] as! [String: Any]
let workerAfter = afterIdle["microphoneWorker"] as! [String: Any]
precondition(workerBefore["startID"] as! String == workerAfter["startID"] as! String)
precondition((workerBefore["cpuS"] as! Double) < (beforeIdle["reapedChildrenCpuS"] as! Double), "decode CPU mislabeled as worker")
precondition((workerAfter["cpuS"] as! Double) - (workerBefore["cpuS"] as! Double) < 0.01)
precondition((afterIdle["reapedChildrenCpuS"] as! Double) == (beforeIdle["reapedChildrenCpuS"] as! Double))
stageCallWorker.stop()
let after = stageBenchProcessTree()!
precondition((after["cpuS"] as! Double) - (first["cpuS"] as! Double) >= 0.12, "cpu: " + String(describing: after))
precondition((after["childrenCpuS"] as! Double) >= 0.12, "children: " + String(describing: after))
precondition((after["liveChildren"] as! Int) == 0 && (after["querySpawns"] as! Int) == 1)
precondition((after["packageWakeups"] as! UInt64) >= (first["packageWakeups"] as! UInt64))
precondition((after["interruptWakeups"] as! UInt64) >= (first["interruptWakeups"] as! UInt64))
// Hold an exited child unreaped to check the live-to-collected boundary for double counting.
var actions: posix_spawn_file_actions_t? = nil; precondition(posix_spawn_file_actions_init(&actions) == 0)
precondition(posix_spawn_file_actions_addopen(&actions, 1, "/dev/null", O_WRONLY, 0) == 0)
let argv = [CommandLine.arguments[0], "--burn"].map { strdup($0) } + [nil]
var zombiePid: pid_t = 0
precondition(posix_spawn(&zombiePid, CommandLine.arguments[0], &actions, nil, argv, environ) == 0)
argv.forEach { free($0) }; posix_spawn_file_actions_destroy(&actions)
let until = CACurrentMediaTime() + 15
var exited = false
repeat {
    var raw = rusage_info_v2()
    let result = withUnsafeMutablePointer(to: &raw) { $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
        proc_pid_rusage(zombiePid, RUSAGE_INFO_V2, $0)
    } }
    exited = result == 0 && raw.ri_proc_exit_abstime > 0
    if !exited { usleep(1000) }
} while !exited && CACurrentMediaTime() < until
let zombie = stageBenchProcessTree()!
if !exited { kill(zombiePid, SIGKILL) }
var status: Int32 = 0, collected = false
let collectUntil = CACurrentMediaTime() + 1
repeat {
    if waitpid(zombiePid, &status, WNOHANG) == zombiePid { collected = true; break }
    usleep(1000)
} while CACurrentMediaTime() < collectUntil
precondition(collected && status == 0)
let reaped = stageBenchProcessTree()!
precondition(exited && (zombie["cpuS"] as! Double) <= (reaped["cpuS"] as! Double) + 0.002,
    "zombie double count: " + String(describing: zombie) + " -> " + String(describing: reaped))
print(String(data: try JSONSerialization.data(withJSONObject: ["before": first, "live": live, "after": after, "zombie": zombie, "reaped": reaped,
    "beforeIdle": beforeIdle, "afterIdle": afterIdle]), encoding: .utf8)!)
`);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', binary],
      { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
    assertChildStatus(built, 0, built.stderr);
    const ran = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    assertChildStatus(ran, 0, ran.stderr);
    const row = JSON.parse(ran.stdout);
    assert.ok(row.after.cpuS - row.before.cpuS >= 0.12);
    assert.equal(row.after.liveChildren, 0);
    t.diagnostic('CHV4F one-second worker idle receipt ' + JSON.stringify({ before: row.beforeIdle, after: row.afterIdle }));
  });
