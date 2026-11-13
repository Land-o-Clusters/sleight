import { assertChildStatus } from './fixtures/child-status.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const folder = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-chip-lifecycle-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
let binary;
function probe() {
  if (binary) return binary;
  const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const between = (start, end, from = 0) => {
    const first = source.indexOf(start, from), last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `missing Swift fixture boundary: ${start}`);
    return source.slice(first, last);
  };
  const chips = between('struct EdgeChipMessage {', '// Pure parser and mood-state probe.')
    .replace(between('final class EdgeChipView:', 'final class EdgeChipHost {'), '');
  const observers = between('        func observe(_ center:', '    func configureStageMouse()', source.indexOf('final class PerchHost {'))
    .replace('let workspace = NSWorkspace.shared.notificationCenter, distributed = DistributedNotificationCenter.default()',
      'let workspace = self.workspace, distributed = self.distributed');
  const capture = between('            let parts = object.split(separator: ":")', '        DispatchQueue.global(qos: .utility).async { self.read() }', source.indexOf('final class HandHost:'))
    .replace('DistributedNotificationCenter.default()', 'CaptureNoticeProbe()');
  // Real chip lifecycle and notification handlers; only window services and panel surfaces are fake.
  // No NSApplication, NSPanel, real window list or distributed notification is used.
  const swift = `import AppKit
import QuartzCore
var clock = 0.0, snapshotAvailable = true, snapshotReads = 0
func CACurrentMediaTime() -> Double { clock }
func CGWindowListCopyWindowInfo(_ options: CGWindowListOption, _ id: CGWindowID) -> CFArray? {
    snapshotReads += 1; return snapshotAvailable ? [] as CFArray : nil
}
func stageRectValid(_ r: CGRect) -> Bool { !r.isEmpty && !r.isNull }
func appKitRect(_ r: CGRect) -> CGRect { r }
struct World {
    struct Base { var fullScreen = false, window = CGRect(x: 200, y: 300, width: 900, height: 500), above: [CGRect] = [] }
    var base = Base(), usable = CGRect(x: 0, y: 30, width: 1800, height: 1000), cards: [CGRect] = [], person = CGRect(x: 1400, y: 700, width: 100, height: 100)
}
func stageWorld(pid: Int32, window: UInt32, pointerAway: Double, locked: Bool, sleeping: Bool, call: Bool, snapshot: [[String: Any]]?) -> World? { World() }
struct CharacterEntry { var sheet = "sheet", columns = [0] }
struct CharacterFrame { var table: [String: CharacterEntry] = [:], cell = CGSize(width: 192, height: 208) }
struct Character { var frame = CharacterFrame(), images: [String: CGImage] = [:] }
enum PerchPlan { static func rect(_ entry: CharacterEntry, _ column: Int, cell: CGSize) -> CGRect { .zero } }
struct NonceBook { func nonce(_ channel: String) -> String? { nil } }
let nonceBook = NonceBook()
func narrationJSON(_ value: [String: Any]) { fatalError("replay must not run") }
final class EdgeChipView {
    var wantsLayer = false, layer: CALayer? = CALayer(), toolTip: String?, clickable = false, click: (() -> Void)?
    init(frame: CGRect) {}
}
final class HandPanel {
    var isOpaque = false, backgroundColor = NSColor.clear, hasShadow = false, level = NSWindow.Level.floating
    var sharingType = NSWindow.SharingType.none, ignoresMouseEvents = true, hidesOnDeactivate = false
    var collectionBehavior: NSWindow.CollectionBehavior = [], frame = CGRect.zero, isVisible = false
    var screen: NSScreen? { nil }
    var contentView: EdgeChipView?
    init(contentRect: CGRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {}
    func orderOut(_ sender: Any?) { isVisible = false }
    func setFrame(_ rect: CGRect, display: Bool) { frame = rect }
    func orderFrontRegardless() { isVisible = true }
}
struct StageProbe { func observe(_ now: Double, world: Int, reduced: Bool) -> Int { 0 } }
final class CallSubscriptionProbe {
    var refreshes = 0
    func refreshSubscription() { refreshes += 1 }
}
final class PerchHost {
    weak var host: HandHost?
    var stageLocked = false, stageSleeping = false, stageActive = false, stage = StageProbe(), now = 0.0
    var frame = CGRect.null, loaded: Character?
    let stageCall = CallSubscriptionProbe()
    let workspace = NotificationCenter(), distributed = NotificationCenter()
    var stageObservers: [(NotificationCenter, NSObjectProtocol)] = []
    func stageEnvironment() -> Int { 0 }
    func performStage(_ effect: Int) { fatalError("stage drawing must not run") }
    init(host: HandHost) {
        self.host = host
${observers}
}
struct CaptureNoticeProbe {
    func postNotificationName(_ name: Notification.Name, object: String, userInfo: [AnyHashable: Any]?, deliverImmediately: Bool) {}
}
final class HandHost {
    var cursorStyle = "sprite", captureHolds: [String: Date] = [:]
    var captureHeld: Bool { captureHolds = captureHolds.filter { $0.value > Date() }; return !captureHolds.isEmpty }
    lazy var perch = PerchHost(host: self)
    lazy var edgeChips = EdgeChipHost(host: self)
    func hide() { edgeChips.hide() }
    func capture(_ object: String) {
        let name = "fixture"
${capture}
}
${chips}
let host = HandHost(), token = String(repeating: "a", count: 32), other = String(repeating: "b", count: 32)
let chips = host.edgeChips
func visible() -> Bool { chips.panels["42:7"]?.isVisible == true }
func check(_ ok: Bool, _ message: String) { if !ok { fputs(message + "\\n", stderr); exit(1) } }
func populate() { chips.receive(EdgeChipMessage(op: "put", pid: 42, window: 7, count: 3, first: 1, time: 1)); chips.receive(EdgeChipMessage(op: "end")) }
let scenario = CommandLine.arguments[1]
populate(); check(visible(), "initial chip should draw")
switch scenario {
case "capture":
    host.capture("begin:" + token); check(!visible(), "capture must hide")
    host.capture("begin:" + other); host.capture("end:" + token)
    check(!visible(), "overlapping capture must remain hidden")
    host.capture("end:" + other); check(visible(), "capture end must redraw without another action")
case "notifications":
    for (center, down, up) in [(host.perch.workspace, NSWorkspace.screensDidSleepNotification, NSWorkspace.screensDidWakeNotification),
        (host.perch.workspace, NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.sessionDidBecomeActiveNotification),
        (host.perch.distributed, Notification.Name("com.apple.screenIsLocked"), Notification.Name("com.apple.screenIsUnlocked"))] {
        center.post(name: down, object: nil); check(!visible(), "lock or sleep must hide")
        center.post(name: up, object: nil); check(visible(), "unlock or wake must redraw without another action")
    }
    host.perch.workspace.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
    host.perch.distributed.post(name: Notification.Name("com.apple.screenIsLocked"), object: nil)
    host.perch.workspace.post(name: NSWorkspace.screensDidWakeNotification, object: nil)
    check(!visible(), "wake must not override lock")
    host.perch.distributed.post(name: Notification.Name("com.apple.screenIsUnlocked"), object: nil)
    check(visible(), "last suppression ending must redraw")
    check(host.perch.stageCall.refreshes == 4, "screen sleep and wake must refresh the call subscription")
case "retry":
    host.capture("begin:" + token)
    check(!visible() && chips.wake != nil, "a held chip must retain a refresh wake")
    let reads = snapshotReads
    chips.refresh(); check(snapshotReads == reads, "held refresh must not read window metadata")
    host.captureHolds[token] = Date.distantPast
    chips.wake?.perform(); check(visible(), "expired hold must redraw on the retained wake")
    snapshotAvailable = false; chips.refresh()
    check(!visible() && chips.wake != nil, "missing metadata must hide and retry")
    snapshotAvailable = true; chips.wake?.perform(); check(visible(), "metadata recovery must redraw")
case "expiry":
    host.capture("begin:" + token); clock = 600
    chips.wake?.perform()
    check(chips.rows.isEmpty && chips.panels.isEmpty && chips.wake == nil, "hidden chips must expire without polling forever")
    host.capture("end:" + token); check(!visible(), "capture end must not revive expired chips")
    populate(); chips.receive(EdgeChipMessage(op: "clear"))
    host.perch.distributed.post(name: Notification.Name("com.apple.screenIsUnlocked"), object: nil)
    check(chips.rows.isEmpty && chips.wake == nil && !visible(), "clear must stay cleared after unlock")
default: fatalError("unknown scenario")
}
chips.receive(EdgeChipMessage(op: "clear"))
`;
  const file = join(folder, 'lifecycle.swift'), output = join(folder, 'lifecycle');
  writeFileSync(file, swift);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', output], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr.slice(0, 8000));
  binary = output;
  return binary;
}
for (const [scenario, title] of Object.entries({
  capture: 'capture end redraws chips after the last overlapping hold',
  notifications: 'unlock and display wake redraw chips without another action',
  retry: 'hidden chips retain a wake for expired holds and unavailable metadata',
  expiry: 'hidden chips expire and cleared chips cannot reappear',
})) {
  test(title, { skip: macCommandSkip('xcrun') }, () => {
    const run = spawnSync(probe(), [scenario], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assertChildStatus(run, 0, run.stderr || run.stdout);
  });
}
