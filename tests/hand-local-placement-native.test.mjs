import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, realpathSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('CH-4 host placement admits both drag windows even while ring rendering is queued', { skip: macCommandSkip('xcrun'), timeout: 900000 }, t => {
  const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-local-placement-'))));
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  if (process.env.CHV1B_VARIANT) {
    const variants = {
      'drop-destination': ['at: incoming.state == "drag" ? incoming.path.last ?? at : at', 'at: at'],
      'stale-placement': ['incoming.seq == sequence, let at = incoming.at', 'let at = incoming.at'],
    };
    const change = variants[process.env.CHV1B_VARIANT]; assert.ok(change, 'known broken variant');
    assert.ok(source.includes(change[0]), 'production mutation site'); source = source.replace(...change);
  }
  const code = join(root, 'placement.swift'), binary = join(root, 'placement');
  const main = source.indexOf('\nlet arguments = Array(CommandLine.arguments');
  assert.ok(main > 0, 'remove the entire production entry point before executing the fixture');
  // Execute production types and placement with inert rendering boundaries. No app, panel or layer exists.
  writeFileSync(code, source.slice(0, main) + `
let host = HandHost(), a = CGRect(x: 100, y: 500, width: 500, height: 300), b = CGRect(x: 900, y: 500, width: 500, height: 300)
let first = StageWindowKey(pid: 42, window: 7), second = StageWindowKey(pid: 42, window: 8)
let world = StageWorld(base: PerchWorld(window: a, above: [], display: CGRect(x: 0, y: 0, width: 1800, height: 1200), top: 30, fullScreen: false),
    usable: CGRect(x: 0, y: 30, width: 1800, height: 1140), person: CGRect(x: 1600, y: 900, width: 150, height: 200),
    pointer: CGPoint(x: 1750, y: 1150), inputAge: 20, pointerAway: 10, windows: [first: a, second: b], orderedWindows: [first, second])
host.admissionWorld = { _ in world }; host.cursorStyle = "sprite"; host.perch.enabled = true
host.perch.stage.options.size = "stage"; host.perch.stageEffects = { _ in }; host.ringEffects = { _ in }
let sheet = "${root}/sheet.png"
let entry: [String: Any] = ["sheet": "sheet", "row": 0, "frames": [0,1], "ms": [200,200], "loop": true, "flip": false,
    "hotspot": [96,104], "size": [1536,208], "scale": 0.5]
let keys = ["perch", "perch-peek", "perch-hop", "perch-point-left", "perch-point-right", "sleep", "high-five", "perch-wait", "startle", "jumping", "running-right", "running-left", "error", "handoff", "paused"]
let raw: [String: Any] = ["hand": "character", "nonce": String(repeating: "a", count: 64), "seq": 0, "id": "fixture", "sheet": sheet,
    "extra": NSNull(), "cell": [192,208], "table": ["idle": entry.merging(["frames": 2]) { _, v in v }],
    "perch": ["anchor": [96,208], "table": Dictionary(uniqueKeysWithValues: keys.map { ($0, entry) })], "size": "stage", "stageAttention": false]
guard case let .character(_, frame)? = handFrame(raw) else { exit(65) }
host.perch.stage.load(frame); host.perch.stage.stageArt = true
host.perch.loaded = SpriteCharacter(frame: frame, images: [:], stage: SpriteStageCache(frame: frame))
host.pauseTarget = RingEvent(seq: 3, state: "drag", pid: 42, windowId: 7, at: CGPoint(x: 350, y: 700), rect: nil, label: nil,
    windowRect: a, path: [CGPoint(x: 350, y: 700), CGPoint(x: 1150, y: 700)])
let placed = host.placeLocalTarget(3)
let windows = host.perch.stage.wideWindows.map { Int($0.window) }.sorted()
let retained = host.perch.stage.turnTargets.count
let stale = host.placeLocalTarget(2)
let clear: [String: Any] = ["hand": "clear", "nonce": String(repeating: "a", count: 64), "token": String(repeating: "b", count: 32), "placed": true, "placementSeq": 3, "keepStage": true]
var noSeq = clear; noSeq.removeValue(forKey: "placementSeq")
var booleanSeq = clear; booleanSeq["placementSeq"] = true
var negativeSeq = clear; negativeSeq["placementSeq"] = -1
var falsePlaced = clear; falsePlaced["placed"] = false
var unknown = clear; unknown["extra"] = true
let row: [String: Any] = ["placed": placed, "wide": windows, "targets": retained, "stale": stale,
    "afterStale": host.perch.stage.turnTargets.count, "clearAccepted": handFrame(clear) != nil,
    "invalidAccepted": [noSeq, booleanSeq, negativeSeq, falsePlaced, unknown].map { handFrame($0) != nil },
    "windows": host.panel == nil && host.perch.panel == nil && host.pauseOverlay.panel == nil ? 0 : 1,
    "layers": host.ringRoot == nil && host.hand == nil && host.glove == nil ? 0 : 1]
print(String(data: try! JSONSerialization.data(withJSONObject: row), encoding: .utf8)!)
`);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), code, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.placed, true); assert.deepEqual(row.wide, [7, 8]); assert.ok(row.targets > 0);
  assert.equal(row.stale, false); assert.equal(row.windows, 0); assert.equal(row.layers, 0);
  assert.ok(row.afterStale >= row.targets, 'withdrawal retains admitted protection');
  assert.equal(row.clearAccepted, true); assert.deepEqual(row.invalidAccepted, [false, false, false, false, false]);
});
