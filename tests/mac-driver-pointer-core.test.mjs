// Real RT2 binding and retained-map adapter, with fake inventory and a recording sink.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { normalizeMacDriverError, formatMacDriverError } from '../plugins/sleight/lib/mac-driver/errors.mjs';
import { clipboardClientReply } from './fixtures/mac-driver-clipboard-client.mjs';
import { fakeInventory, coordinate, changedTargets, coordinateReplayCases } from './fixtures/uc2d-coordinate.mjs';
import { replayCoordinates } from '../bench/replay/coordinate-targets.mjs';
import { DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

const ancestryDetail = "The target's accessibility tree is incomplete. Try another element from a read or a keyboard route.";

const darwin = process.platform === 'darwin';
const nativeTest = (name, fn) => test(name, { skip: !darwin && 'Swift core fixture needs macOS' }, fn);
let executable;

const fixture = String.raw`
import Foundation
import AppKit

enum NSPasteboard {
    struct Board { var changeCount: Int { fatalError("real board adapter forbidden") } }
    static var general: Board { Board() }
}

final class CoreRecordingSink: DriverPointerSink, DriverPointerPrepared {
    var posts = 0, releases = 0, prepares = 0
    var points: [[Double]] = []
    var window: DriverPointerWindow?
    var steps: [DriverPointerStep] = []
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        prepares += 1
        self.steps = steps; self.window = window; return self
    }
    func post(_ index: Int) throws {
        posts += 1; points.append([steps[index].event.point.x, steps[index].event.point.y])
    }
    func release(_ index: Int) throws { releases += 1 }
}

@main struct CoreFixture {
    static func main() {
        let nonce = String(repeating: "a", count: 64)
        while let line = readLine() {
            do {
                let input = try DriverJSON.decode(Data(line.utf8))
                let inventory = input["fixture"] as! DriverObject
                let tree = (inventory["trees"] as! DriverObject)["42"] as! DriverObject
                let core = DriverCore(fixture: inventory)
                coordinateBrokenCheck = input["brokenCheck"] as? String ?? ""
                coordinateGeometryBroken = input["brokenGeometry"] as? Bool == true
                func request(_ id: Int, _ method: String, _ params: DriverObject) throws -> DriverRequest {
                    try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": id,
                        "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 5000],
                        nonce: nonce, previous: id - 1)
                }
                let binding: DriverObject = ["windowId": "42", "processStart": "fake-start"]
                _ = try core.readTree(binding, request: request(1, "getAXState", binding))
                var params = binding; params["readId"] = 1; params["args"] = input["args"] ?? [1]
                if input["coordinateTest"] as? Bool == true {
                    core.coordinateMaps[1] = core.maps["42"]
                    if input["partialMap"] as? Bool == true { core.coordinateMaps[1]?.truncated = true }
                    params["coordinateReadId"] = 1
                }
                if let overrides = input["params"] as? DriverObject { params.merge(overrides) { _, new in new } }
                if input["evict"] as? Bool == true { core.maps.removeAll() }
                if input["replaceRoot"] as? Bool == true, let map = core.maps["42"] {
                    core.maps["42"] = DriverReadMap(id: map.id, processStart: map.processStart,
                        root: DriverNode(fake: tree, path: "other-root"), elements: map.elements)
                }
                if let status = input["coordinateStatus"] as? String {
                    let node = input["nilHit"] as? Bool == true ? nil : DriverNode(fake: tree, path: "42")
                    var result: DriverObject
                    do { _ = try DriverPointer.checkedCoordinateHit(status == "noValue" ? .noValue : .success, node); result = ["ok": true] }
                    catch let error as DriverPointerFault { result = ["ok": false, "code": error.code] }
                    print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
                    continue
                }
                if input["probeCoordinate"] as? Bool == true {
                    let originalMap = core.maps["42"]!
                    var elements = originalMap.elements
                    let hit = (input["hit"] as? DriverObject) ?? (tree["children"] as! [DriverObject])[0]
                    if input["duplicate"] as? Bool == true, let extra = elements[1] { elements[2] = extra }
                    let node = DriverNode(fake: hit, path: input["hitPath"] as? String ?? "42/0")
                    if input["secureIdentity"] as? Bool == true {
                        elements[1]?.coordinateIdentity = driverCoordinateIdentity(try node.attributes(driverCoordinateAttributes, request: request(2,"click",params)))
                    }
                    let map = DriverReadMap(id: originalMap.id, processStart: originalMap.processStart, root: originalMap.root, elements: elements)
                    var result: DriverObject
                    do { let pixels = try DriverPointer.coordinateNeedsPixels(map: map, hit: node,
                        point: CGPoint(x: -160, y: 130), pid: 321, request: request(2,"click",params))
                        result = ["ok": true, "pixels": pixels]
                    } catch let error as DriverFault { result = ["ok": false, "code": error.code] }
                    print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
                    continue
                }
                let sink = CoreRecordingSink()
                var personChecks = 0, coordinateChecks = 0
                var output: DriverObject
                do {
                    let action = try request(2, input["method"] as? String ?? "click", params)
                    let geometry: DriverPointerGeometry? = input["withCapture"] as? Bool == true
                        ? DriverPointerGeometry(bounds: CGRect(x: -200, y: 100, width: 400, height: 300), pixelWidth: 800, pixelHeight: 600) : nil
                    let context = try DriverPointer.context(request: action, core: core, geometry: geometry, checkPerson: {
                        let index = personChecks; personChecks += 1
                        if input["personAt"] as? Int == index { throw DriverFault("PERSON_TOOK_OVER") }
                    }, hitTest: { _ in
                        coordinateChecks += 1
                        let coordinate = input["coordinateTest"] as? Bool == true
                        let threshold = input["hitAfterCheck"] as? Int ?? 1
                        var hit: DriverObject
                        if coordinateChecks > threshold, let after = input["hitAfter"] as? DriverObject { hit = after }
                        else if let supplied = input["hit"] as? DriverObject { hit = supplied }
                        else if coordinate {
                            hit = (tree["children"] as! [DriverObject])[0]
                            hit["AXParent"] = tree
                        } else {
                            hit = ["AXRole": "AXButton", "AXTitle": "Press", "pid": 321,
                                   "AXParent": ["AXRole": "AXWindow", "pid": 321]]
                        }
                        let node = DriverNode(fake: hit, path: coordinate ? (input["hitPath"] as? String ?? "42/0") : "hit")
                        return node
                    }, pixelCheck: { _ in input["pixelsMatch"] as? Bool ?? true })
                    let result: DriverObject
                    if input["coordinateOnce"] as? Bool == true { try context.checkCoordinate?(CGPoint(x: -160, y: 130)); result = [:] }
                    else { result = try DriverPointer.perform(method: action.method, args: params["args"] as! [Any], context: context, sink: sink) }
                    output = ["ok": true, "result": result]
                } catch let error as DriverPointerFault { output = ["ok": false, "error": error.json] }
                output["posts"] = sink.posts; output["releases"] = sink.releases
                output["prepares"] = sink.prepares
                output["personChecks"] = personChecks; output["points"] = sink.points
                output["sinkPID"] = sink.window?.pid ?? 0
                let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
            } catch { fputs("Invalid core fixture input.\n", stderr); exit(65) }
        }
    }
}
`;

before(async () => {
  if (!darwin) return;
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-pointer-core-')));
  const main = join(directory, 'PointerCoreFixture.swift');
  executable = join(directory, 'pointer-core-fixture');
  const composed = macDriverSource();
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  // Adapt the JSON provider for reference cycles and parent lookup failures.
  // Adapt only its data/identity plumbing, leaving the real walk and guards intact.
  let body = composed.slice(0, at);
  for (const [from, to] of [
    ['var result = fake.filter { names.contains($0.key) }',
      'if names == [kAXParentAttribute], fake["parentReadFailure"] as? Bool == true { return [:] }; var result = fake.filter { names.contains($0.key) }'],
    ['DriverNode(fake: parent, path: current.path + "/parent")',
      'DriverNode(fake: parent["parentPath"] as? String == "hit" ? node.fake! : parent, path: parent["parentPath"] as? String ?? current.path + "/parent")'],
  ]) {
    assert.equal(body.split(from).length, 2, 'one fixture adapter seam');
    body = body.replace(from, to);
  }
  body=body.replace('if fake != nil { return self.pid().map { $0 == pid_t(pid) } ?? true }',
    'if fake != nil { if fake?["belongsFailure"] as? Bool == true { return false }; if fake?["belongsOverride"] as? Bool == true { return true }; return self.pid().map { $0 == pid_t(pid) } ?? true }');
  const mutations = [
    ['guard status == .success else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }',
      'guard coordinateBrokenCheck == "hit-status" || status == .success else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }'],
    ['guard node != nil else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }',
      'guard coordinateBrokenCheck == "hit-node" || node != nil else { throw fault("AX_UNAVAILABLE", "The coordinate target could not be checked.") }'],
    ['], !map.truncated,\n                              map.processStart', '], (coordinateBrokenCheck == "truncated" || !map.truncated),\n                              map.processStart'],
    ['core.coordinateMaps[deliveredID],', '(core.coordinateMaps[deliveredID] ?? (coordinateBrokenCheck == "read-id" ? core.coordinateMaps.values.first : nil)),'],
    ['candidates.count <= 1', '(coordinateBrokenCheck == "ambiguity" || candidates.count <= 1)'],
    ['structural[kAXSubroleAttribute] as? String != "AXSecureTextField"', '(coordinateBrokenCheck == "subrole" || structural[kAXSubroleAttribute] as? String != "AXSecureTextField")'],
    ['!expected.coordinateIdentity.values.contains("unsupported")', '(coordinateBrokenCheck == "unsupported" || !expected.coordinateIdentity.values.contains("unsupported"))'],
    ['!expected.secure', '(coordinateBrokenCheck == "secure" || !expected.secure)'],
    ['expected.node.same(hit)', '(coordinateBrokenCheck == "object" || expected.node.same(hit))'],
    ['hit.pid() == pid_t(pid)', '(coordinateBrokenCheck == "pid" || hit.pid() == pid_t(pid))'],
    ['try hit.belongs(to: map.root, pid: pid, request: request)', '(try (coordinateBrokenCheck == "belongs" || hit.belongs(to: map.root, pid: pid, request: request)))'],
    ['try hit.frame(request) == expected.frame', '(try (coordinateBrokenCheck == "frame" || hit.frame(request) == expected.frame))'],
    ['structural[kAXRoleAttribute] as? String == expected.role', '(coordinateBrokenCheck == "role" || structural[kAXRoleAttribute] as? String == expected.role)'],
    ['driverCoordinateIdentity(attrs) == expected.coordinateIdentity', '(coordinateBrokenCheck == "attributes" || driverCoordinateIdentity(attrs) == expected.coordinateIdentity)'],
    ['guard try pixelCheck?(point) == true', 'guard try coordinateBrokenCheck == "pixels" || pixelCheck?(point) == true'],
    ['_ = try coordinateNeedsPixels(map: map, hit: coordinateHit(point), point: point,\n                                pid: pid, request: request)',
      'if coordinateBrokenCheck != "post-capture" { _ = try coordinateNeedsPixels(map: map, hit: coordinateHit(point), point: point, pid: pid, request: request) }'],
  ];
  const checkStart = body.indexOf('    static func coordinateNeedsPixels(');
  const checkEnd = body.indexOf('\n}\n#endif',checkStart);
  let checks = body.slice(checkStart,checkEnd);
  for (const [from,to] of mutations) {
    if (checks.includes(from)) {
      assert.equal(checks.split(from).length,2,from); checks=checks.replace(from,to);
    } else {
      assert.equal(body.split(from).length,2,from); body=body.replace(from,to);
    }
  }
  body=body.replace(body.slice(body.indexOf('    static func coordinateNeedsPixels('),body.indexOf('\n}\n#endif',body.indexOf('    static func coordinateNeedsPixels('))),checks);
  body = body.replace('if let geometry = context.geometry, geometry.bounds != bounds {',
    'if !coordinateGeometryBroken, let geometry = context.geometry, geometry.bounds != bounds {')
    .replace('geometry.bounds == bounds, geometry.pixelWidth.isFinite',
      '(coordinateGeometryBroken || geometry.bounds == bounds), geometry.pixelWidth.isFinite');
  writeFileSync(main, body + '\nvar coordinateBrokenCheck = ""; var coordinateGeometryBroken = false\n' + fixture);
  const compile = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-parse-as-library',
    '-module-cache-path', join(directory, 'module-cache'), main, '-o', executable], { killSignal: 'SIGKILL', timeout: 600000, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
  console.log(`CB1K pointerFixtureBytes=${statSync(executable).size} swiftcExit=${compile.status}`);
});

function run(input = {}) {
  function withPID(node) {
    return { pid: 321, ...node, ...node.AXParent && typeof node.AXParent === 'object' && !Array.isArray(node.AXParent)
      ? { AXParent: withPID(node.AXParent) } : {} };
  }
  if (input.hit) input = { ...input, hit: withPID(input.hit) };
  const result = spawnSync(executable, [], { input: JSON.stringify({ fixture: fakeInventory, ...input }) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function refusal(input, code) {
  const reply = run(input);
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(reply.error.code, code, JSON.stringify(reply));
  assert.equal(reply.error.delivery, 'not-sent');
  assert.equal(reply.posts, 0);
  return reply;
}

nativeTest('RT2 adapter resolves an element from a real retained fake read', () => {
  const reply = run();
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.posts, 2);
  assert.equal(reply.sinkPID, 321);
  assert.deepEqual(reply.points, [[-160, 130], [-160, 130]]);
  assert.equal(reply.result.window.identityVerified, true);
  assert.ok(reply.personChecks >= 3);
});

for (const [name, input] of changedTargets) nativeTest(`UC2D ${name} refuses and detects the broken check`, () => {
  const args = { ...coordinate, ...input };
  refusal(args, 'TARGET_CHANGED');
  if (name === 'same-app overlay') {
    const reply = run(args);
    assert.equal(reply.error.targetRole, 'container');
    assert.match(formatMacDriverError(reply), /found=container;/);
  }
  const broken = run({ ...args, brokenCheck: ({'list scroll':'attributes','sheet with the same label':'object','same-app overlay':'role','identical pixels and changed state':'attributes','target moved 60 points':'frame','changed at the posting boundary':'attributes','partial delivered map':'truncated','expired delivered map':'read-id'})[name] });
  assert.equal(broken.ok, true, 'the no-check mutation must violate the refusal assertion');
  assert.equal(broken.posts, 2);
});

nativeTest('UC2D the unchanged retained object and state allow one down/up pair', () => {
  const reply = run(coordinate);
  assert.equal(reply.ok, true, JSON.stringify(reply)); assert.equal(reply.posts, 2);
});

nativeTest('UC2D a changed target between double-click presses stops with unknown delivery', () => {
  const hitAfter = { ...fakeInventory.trees[42].children[0], AXTitle: 'Changed', AXParent: { AXRole: 'AXWindow', pid: 321 } };
  const reply = run({ ...coordinate, method: 'doubleClick', hitAfter, hitAfterCheck: 2 });
  assert.equal(reply.ok, false); assert.equal(reply.error.code, 'TARGET_CHANGED');
  assert.equal(reply.error.delivery, 'unknown'); assert.equal(reply.posts, 2);
  assert.equal(Object.hasOwn(reply.error, 'targetRole'), false);
  assert.equal(run({ ...coordinate, method: 'doubleClick', hitAfter, hitAfterCheck: 2, brokenCheck: 'attributes' }).posts, 4);
});

nativeTest('UC2D the same canvas container requires the pixel witness', () => {
  const fixture = structuredClone(fakeInventory);
  fixture.trees[42].children[0].AXRole = 'AXCanvas';
  const args = { ...coordinate, fixture, pixelsMatch: false };
  refusal(args, 'TARGET_CHANGED');
  assert.equal(run({ ...args, brokenCheck: 'pixels' }).posts, 2);
  assert.equal(run({ ...args, pixelsMatch: true }).posts, 2);
});

nativeTest('UC2D moved window bounds refuse before compare and detect the broken geometry check', () => {
  const fixture = structuredClone(fakeInventory);
  fixture.windows[0].bounds.x += 1; fixture.trees[42].frame.x += 1;
  const args = { ...coordinate, fixture };
  refusal(args, 'IDENTITY_CHANGED');
  assert.equal(run({ ...args, brokenGeometry: true }).posts, 2);
});

nativeTest('UC2D full attribute hashes catch differences hidden by printed truncation and cleaning', () => {
  for (const [before, after] of [['A'.repeat(17000) + 'before', 'A'.repeat(17000) + 'after'], ['Line\u0000One', 'Line One']]) {
    const fixture = structuredClone(fakeInventory); fixture.trees[42].children[0].AXTitle = before;
    const hit = { ...fixture.trees[42].children[0], AXTitle: after, AXParent: { AXRole: 'AXWindow', pid: 321 } };
    const args = { ...coordinate, fixture, hit };
    refusal(args, 'TARGET_CHANGED');
    assert.equal(run({ ...args, brokenCheck: 'attributes' }).posts, 2);
  }
});

nativeTest('UC2D overlapping deepest frames refuse even when one AX object matches', () => {
  const fixture = structuredClone(fakeInventory);
  fixture.trees[42].children.push({ ...fixture.trees[42].children[0], AXTitle: 'Overlay' });
  const args = { ...coordinate, fixture };
  refusal(args, 'TARGET_CHANGED');
  // The isolated ambiguity probe below keeps both candidate objects identical,
  // so dictionary iteration cannot hide this guard's individual mutation.
});

nativeTest('UC2D a focused pointer target resolves uniquely and refuses an ambiguous focus', () => {
  const fixture = structuredClone(fakeInventory); fixture.trees[42].children[0].AXFocused = true;
  const args = { fixture, args: [{ focused: true }] };
  assert.equal(run(args).posts, 2);
  fixture.trees[42].AXFocused = true;
  refusal(args, 'AMBIGUOUS_ELEMENT');
});

nativeTest('pointer binding refuses an off-Space window before the recording sink', () => {
  const data = structuredClone(fakeInventory); data.windows[0].onScreen = false;
  const row = refusal({ fixture: data }, 'NO_WINDOWS_AVAILABLE');
  assert.match(row.error.message, /another Space or off screen/);
  assert.equal(row.releases, 0);
});

nativeTest('RT2 adapter resolves exact id and label selectors', () => {
  for (const target of [{ id: 'press' }, { label: 'Press' }]) assert.equal(run({ args: [target] }).ok, true);
});

nativeTest('RT2 adapter refuses stale or evicted reads, including screenshot targets', () => {
  for (const args of [[1], [[80, 120]]]) {
    refusal({ args, params: { readId: 2 }, withCapture: true }, 'STALE_READ');
    refusal({ args, evict: true, withCapture: true }, 'STALE_READ');
    refusal({ args, replaceRoot: true, withCapture: true }, 'STALE_READ');
  }
});

nativeTest('RT2 adapter refuses reused process and missing window bindings', () => {
  refusal({ params: { processStart: 'recycled' } }, 'IDENTITY_CHANGED');
  refusal({ params: { windowId: '43' } }, 'WINDOW_NOT_FOUND');
});

nativeTest('RT2 adapter refuses geometry supplied as an input parameter', () => {
  refusal({ params: { geometry: { pixelWidth: 800, pixelHeight: 600 } } }, 'INVALID_PARAMS');
});

nativeTest('RT2 adapter requires trusted capture geometry for coordinate input', () => {
  refusal({ args: [[80, 120]] }, 'CAPTURE_GEOMETRY_REQUIRED');
  const reply = run(coordinate);
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.points, [[-160, 130], [-160, 130]]);
});

nativeTest('RT2 adapter refuses missing, Boolean and zero read IDs', () => {
  for (const readId of [null, true, 0, '1']) refusal({ params: { readId } }, 'INVALID_PARAMS');
});

nativeTest('RT2 adapter resolves missing elements without posting', () => {
  refusal({ args: [{ id: 'gone' }] }, 'STALE_ELEMENT');
});

nativeTest('RT2 adapter requires the person guard before input', () => {
  const reply = refusal({ personAt: 0 }, 'PERSON_TOOK_OVER');
  assert.equal(reply.error.personTookOver, true);
});

nativeTest('RT2 adapter releases a held button when the person guard changes during spacing', () => {
  const reply = run({ personAt: 1 });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.personTookOver, true);
  assert.equal(reply.error.delivery, 'unknown');
  assert.equal(reply.posts, 1);
  assert.equal(reply.releases, 1);
  assert.equal(reply.error.buttonCleanup, 'released');
});

const pointerActions = target => [
  { method: 'click', args: [target] },
  { method: 'doubleClick', args: [target] },
  { method: 'rightClick', args: [target] },
  { method: 'click', args: [target, { mouseButton: 'right' }] },
  { method: 'click', args: [target, { mouseButton: 'middle' }] },
  { method: 'scroll', args: [target, 'down', { pixels: 10 }] },
  { method: 'drag', args: [target, 1] },
  { method: 'drag', args: [1, target] },
];
function clipboardRefusal(input) {
  const reply = refusal(input, 'ACTION_UNSUPPORTED');
  assert.equal(reply.error.retry, 'safe');
  assert.equal(reply.releases, 0);
  assert.equal(reply.prepares, 0);
}

nativeTest('CB1J every pointer method checks retained menu titles and descriptions without equivalents', () => {
  for (const label of ['Copy', 'Cut']) for (const field of ['AXTitle', 'AXDescription']) {
    const fixture = structuredClone(fakeInventory);
    Object.assign(fixture.trees[42].children[0], { AXRole: 'AXMenuItem', AXTitle: 'Neutral', [field]: label });
    for (const action of pointerActions(1)) clipboardRefusal({ fixture, ...action });
  }
});

nativeTest('CB1J coordinate menu hits and their children check labels for every pointer method', () => {
  for (const label of ['Copy', 'Cut']) for (const field of ['AXTitle', 'AXDescription']) {
    const window = { AXRole: 'AXWindow' };
    const item = { AXRole: 'AXMenuItem', [field]: label, AXParent: window };
    for (const hit of [item, { AXRole: 'AXStaticText', AXTitle: 'Neutral', AXParent: item },
      { AXRole: 'AXStaticText', [field]: label, AXParent: { AXRole: 'AXGroup', AXParent: { AXRole: 'AXMenu', AXParent: window } } }]) {
      for (const action of pointerActions([80, 120])) clipboardRefusal({ hit, withCapture: true, ...action });
    }
  }
});

nativeTest('CB1J non-menu and secure hit ancestry never reads labels', () => {
  const forbidReads = ['AXTitle', 'AXDescription', 'AXValue'];
  for (const hit of [
    { AXRole: 'AXStaticText', forbidReads, AXParent: { AXRole: 'AXWindow', forbidReads } },
    { AXRole: 'AXStaticText', forbidReads, AXParent: { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', forbidReads } },
  ]) {
    const reply = run({ hit, withCapture: true, method: 'rightClick', args: [[80, 120]] });
    assert.equal(reply.ok, false, JSON.stringify(reply));
    assert.equal(reply.error.code, hit.AXParent.AXSubrole === 'AXSecureTextField' ? 'SECURE_FIELD' : 'TARGET_CHANGED');
    assert.equal(reply.posts, 0);
  }
});

nativeTest('CB1J menu ancestry exhaustion refuses before preparing any events', () => {
  let hit = { AXRole: 'AXMenu', AXTitle: 'Copy' };
  for (let i = 0; i < 66; i++) hit = { AXRole: 'AXGroup', AXParent: hit };
  ancestryRefusal(hit, 'ACTION_UNSUPPORTED');
});

function ancestryRefusal(hit, code) {
  for (const action of pointerActions([80, 120])) {
    const reply = refusal({ hit, withCapture: true, ...action }, code);
    assert.equal(reply.prepares, 0);
    assert.equal(reply.releases, 0);
    if (code === 'ACTION_UNSUPPORTED') {
      assert.equal(reply.error.message, ancestryDetail);
      assert.equal(reply.error.pointerRefusal, 'incomplete-ancestry');
      const normalized = normalizeMacDriverError(reply, { action: true });
      assert.equal(normalized.message, ancestryDetail);
      assert.equal(normalized.delivery, 'not-sent');
      assert.equal(normalized.retry, 'read-first');
      assert.equal(normalized.next, 'none');
      assert.equal(normalized.unhealthy, false);
      const line = formatMacDriverError(reply, { action: true });
      assert.ok(line.includes(ancestryDetail));
      assert.match(line, /delivery=not-sent; retry=read-first;/);
      assert.match(line, /next=none: Do not retry this operation\./);
      assert.doesNotMatch(line, /retry-safe|retry only/);
    }
  }
}

for (const AXRole of ['AXStaticText', 'AXGroup', '', 'AXMenuItem', 'AXMenu']) {
  nativeTest(`CB1K missing parent for role ${JSON.stringify(AXRole)} refuses before any event`, () => {
    ancestryRefusal({ AXRole, AXTitle: 'Neutral' }, 'ACTION_UNSUPPORTED');
    for (const terminal of ['AXWindow', 'AXApplication']) {
      const reply = run({ hit: { AXRole: 'AXMenuItem', AXTitle: 'Neutral',
        AXParent: { AXRole: terminal, forbidReads: ['AXTitle', 'AXDescription', 'AXValue'] } },
        withCapture: true, method: 'rightClick', args: [[80, 120]] });
      assert.equal(reply.ok, false, JSON.stringify(reply));
      assert.equal(reply.error.code, 'TARGET_CHANGED');
      assert.equal(reply.posts, 0);
    }
  });
}

// Native attributes drops per-attribute AXError, even when the batch succeeds.
for (const AXRole of ['AXStaticText', 'AXMenuItem']) {
  nativeTest(`CB1K failed parent read for ${AXRole} refuses before any event`, () => {
    ancestryRefusal({ AXRole, parentReadFailure: true,
      AXParent: { AXRole: 'AXMenuItem', AXTitle: 'Copy' } }, 'ACTION_UNSUPPORTED');
  });
}

for (const AXRole of [null, true, '']) {
  nativeTest(`CB1K unreadable role ${JSON.stringify(AXRole)} cannot hide a menu ancestor`, () => {
    ancestryRefusal({ AXRole, AXParent: { AXRole: 'AXWindow' } }, 'ACTION_UNSUPPORTED');
    ancestryRefusal({ AXRole: 'AXStaticText', AXParent: { AXRole, AXParent: { AXRole: 'AXWindow' } } }, 'ACTION_UNSUPPORTED');
  });
}

for (const pid of [999, null]) {
  nativeTest(`CB1K foreign or unreadable parent PID ${pid} refuses before any event`, () => {
    ancestryRefusal({ AXRole: 'AXStaticText', AXParent: { AXRole: 'AXWindow', pid } }, 'STALE_ELEMENT');
  });
}

nativeTest('CB1K cyclic parent identity refuses before any event', () => {
  ancestryRefusal({ AXRole: 'AXGroup', AXParent: { AXRole: 'AXGroup', parentPath: 'hit' } }, 'STALE_ELEMENT');
});

nativeTest('CB1K a secure ancestor cannot allow an already detected menu hit', () => {
  ancestryRefusal({ AXRole: 'AXMenuItem', AXTitle: 'Neutral',
    AXParent: { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', forbidReads: ['AXTitle', 'AXDescription', 'AXValue'] } },
  'ACTION_UNSUPPORTED');
});

nativeTest('CB1L missing role refuses with an incomplete-tree recovery', () => {
  ancestryRefusal({ AXParent: { AXRole: 'AXWindow' } }, 'ACTION_UNSUPPORTED');
  ancestryRefusal({ AXRole: 'AXGroup', AXParent: { AXParent: { AXRole: 'AXWindow' } } }, 'ACTION_UNSUPPORTED');
});

nativeTest('CB1L invalid parent type refuses with an incomplete-tree recovery', () => {
  for (const AXParent of [null, true, 'unreadable', []]) {
    ancestryRefusal({ AXRole: 'AXGroup', AXParent }, 'ACTION_UNSUPPORTED');
  }
});

nativeTest('CB1L non-menu walk allows a window at depth 65 and refuses depth 66', () => {
  let hit = { AXRole: 'AXWindow', forbidReads: ['AXTitle', 'AXDescription', 'AXValue'] };
  for (let i = 0; i < 65; i++) hit = { AXRole: 'AXGroup', AXParent: hit };
  const reply = run({ hit, withCapture: true, method: 'click', args: [[80, 120]] });
  assert.equal(reply.ok, false, JSON.stringify(reply));
  assert.equal(reply.error.code, 'TARGET_CHANGED');
  assert.equal(reply.posts, 0);
  ancestryRefusal({ AXRole: 'AXGroup', AXParent: hit }, 'ACTION_UNSUPPORTED');
});

test('CB1O incomplete-tree recovery uses only its typed not-sent refusal', () => {
  const error = { code: 'ACTION_UNSUPPORTED', pointerRefusal: 'incomplete-ancestry', message: 'provider diagnostic', delivery: 'not-sent', retry: 'safe' };
  const normalized = normalizeMacDriverError(error, { action: true });
  assert.equal(normalized.message, ancestryDetail);
  assert.equal(normalized.retry, 'read-first');
  assert.equal(normalized.next, 'none');
  for (const overrides of [{ pointerRefusal: undefined }, { pointerRefusal: 'unknown' }, { code: 'AX_UNAVAILABLE' },
    { delivery: 'unknown' }, { delivery: 'sent-unverified' }]) {
    assert.notEqual(normalizeMacDriverError({ ...error, ...overrides }, { action: true }).message, ancestryDetail);
  }
});

nativeTest('CB1L native ancestry refusal survives the client and reaches the model formatter', async () => {
  for (const action of pointerActions([80, 120])) {
    const native = run({ hit: { AXRole: 'AXGroup' }, withCapture: true, ...action });
    assert.equal(native.ok, false);
    assert.equal(native.error.pointerRefusal, 'incomplete-ancestry');
    assert.equal(native.prepares, 0);
    assert.equal(native.posts, 0);
    assert.equal(native.releases, 0);
    // The registrar supplies the closed-table next value. The wire's safe
    // proves non-delivery; the model formatter supplies stricter recovery.
    const reply = await clipboardClientReply({ ...native, error: { ...native.error, next: DRIVER_CODES[native.error.code].next } }, { method: action.method });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'ACTION_UNSUPPORTED');
    assert.equal(reply.error.pointerRefusal, 'incomplete-ancestry');
    assert.equal(reply.error.message, ancestryDetail);
    assert.equal(reply.error.delivery, 'not-sent');
    assert.equal(reply.error.retry, 'read-first');
    assert.equal(reply.error.next, 'none');
    assert.match(formatMacDriverError(reply), /Try another element from a read or a keyboard route\./);
  }
});

nativeTest('UC2D coordinate replay: 11 synthetic cells, 9 refused, 2 allowed, zero wrong targets', () => {
  const result = replayCoordinates(coordinateReplayCases(), run);
  assert.deepEqual(result, { cells: 11, allowed: 2, refused: 9, wrong: 0 });
  console.log('UC2D coordinate replay ' + JSON.stringify(result));
});

for (const [name, input, code] of [
  ['ambiguity', {duplicate:true}, 'TARGET_CHANGED'],
  ['object', {hitPath:'42/replaced'}, 'TARGET_CHANGED'],
  ['pid', {hit:{...fakeInventory.trees[42].children[0],pid:999,belongsOverride:true}}, 'TARGET_CHANGED'],
  ['belongs', {hit:{...fakeInventory.trees[42].children[0],belongsFailure:true}}, 'TARGET_CHANGED'],
  ['frame', {hit:{...fakeInventory.trees[42].children[0],frame:{x:-180,y:120,width:41,height:20}}}, 'TARGET_CHANGED'],
  ['role', {hit:{...fakeInventory.trees[42].children[0],AXRole:'AXGroup'}}, 'TARGET_CHANGED'],
  ['attributes', {hit:{...fakeInventory.trees[42].children[0],AXTitle:'Changed'}}, 'TARGET_CHANGED'],
  ['subrole', {hit:{...fakeInventory.trees[42].children[0],AXSubrole:'AXSecureTextField'}}, 'TARGET_CHANGED'],
  ['unsupported', {fixture:{...fakeInventory,trees:{42:{...fakeInventory.trees[42],children:[{...fakeInventory.trees[42].children[0],AXTitle:[]}]}}}}, 'TARGET_CHANGED'],
  ['secure', {fixture:{...fakeInventory,trees:{42:{...fakeInventory.trees[42],children:[{...fakeInventory.trees[42].children[0],AXRole:'AXSecureTextField'}]}}},secureIdentity:true}, 'SECURE_FIELD'],
]) nativeTest(`UC2D2 independent ${name} check detects its own mutation`,()=>{
  const args={...input,probeCoordinate:true};
  const good=run(args); assert.equal(good.ok,false,JSON.stringify(good)); assert.equal(good.code,code);
  const broken=run({...args,brokenCheck:name}); assert.equal(broken.ok,true,JSON.stringify(broken));
});
nativeTest('UC2D2 post-capture AX recheck detects its own mutation',()=>{
  const fixture=structuredClone(fakeInventory); fixture.trees[42].children[0].AXRole='AXCanvas';
  const input={...coordinate,coordinateOnce:true,fixture,hitAfterCheck:1,hitAfter:{...fixture.trees[42].children[0],AXTitle:'Changed during capture',AXParent:fixture.trees[42]},pixelsMatch:true};
  refusal(input,'TARGET_CHANGED'); assert.equal(run({...input,brokenCheck:'post-capture'}).ok,true);
});

for (const [name,input] of [['hit-status',{coordinateStatus:'noValue'}],['hit-node',{coordinateStatus:'success',nilHit:true}]])
  nativeTest(`UC2D2 ${name} refuses and detects its own mutation`,()=>{
    assert.deepEqual(run(input),{ok:false,code:'AX_UNAVAILABLE'});
    assert.deepEqual(run({...input,brokenCheck:name}),{ok:true});
  });
