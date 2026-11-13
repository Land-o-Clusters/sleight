// Offline only: the compiled fixture replaces native posting with an in-memory recorder.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const darwin = process.platform === 'darwin';
const nativeTest = (name, fn) => test(name, { skip: !darwin && 'Swift pointer fixture needs macOS' }, fn);
const source = fileURLToPath(new URL('../plugins/sleight/lib/mac-driver/native/DriverPointer.swift', import.meta.url));
let executable;

const fixture = String.raw`
import Foundation
import AppKit
import CoreGraphics

var pointerTestPosts: [[String: Any]] = []
func pointerTestPost(_ event: CGEvent, _ pid: pid_t) {
    pointerTestPosts.append(["type": event.type.rawValue, "flags": event.flags.rawValue, "pid": pid])
}
final class NativeFixtureSink: DriverPointerSink {
    var prepared: DriverPointerNativeSink.Prepared?
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        let value = try DriverPointerNativeSink().prepare(steps, window: window) as! DriverPointerNativeSink.Prepared
        prepared = value; return value
    }
}
func numeric(_ value: Any?, _ fallback: Double) -> Double { DriverPointer.number(value) ?? fallback }
func rectangle(_ value: Any?, _ fallback: CGRect) -> CGRect {
    guard let a = value as? [Double], a.count == 4 else { return fallback }
    return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
}
func eventJSON(_ event: DriverPointerEvent) -> [String: Any] {
    ["type": event.type.rawValue, "point": [event.point.x, event.point.y], "button": event.button.rawValue,
     "count": event.clickCount, "wheelX": event.wheelX, "wheelY": event.wheelY]
}
final class FakeSink: DriverPointerSink, DriverPointerPrepared {
    var steps: [DriverPointerStep] = []
    var posted: [[String: Any]] = [], released: [[String: Any]] = []
    var prepareCount = 0
    let input: [String: Any]
    init(_ input: [String: Any]) { self.input = input }
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared {
        prepareCount += 1
        if input["failPrepare"] as? Bool == true { throw DriverPointer.fault("EVENT_BUILD_FAILED", "Fake preparation failure.") }
        self.steps = steps
        return self
    }
    func validate(_ index: Int) throws {
        if input["failValidateAt"] as? Int == index { throw DriverPointer.fault("EVENT_BUILD_FAILED", "Fake flag refusal.") }
    }
    func post(_ index: Int) throws {
        posted.append(eventJSON(steps[index].event))
        if input["failPostAt"] as? Int == index { throw DriverPointer.fault("POST_FAILED", "Fake uncertain post.") }
    }
    func release(_ index: Int) throws {
        if input["failRelease"] as? Bool == true { throw DriverPointer.fault("RELEASE_FAILED", "Fake release failure.") }
        released.append(eventJSON(steps[index].release!))
    }
}

@main struct PointerFixture {
    static func main() {
        while let line = readLine() {
            do {
                let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
                let sink = FakeSink(input), nativeSink = NativeFixtureSink()
                pointerTestPosts = []
                var checks = 0, readChecks = 0, resolves = 0, releaseChecks = 0, admissions = 0
                var waits: [Double] = []
                let bounds = rectangle(input["bounds"], CGRect(x: -200, y: 100, width: 400, height: 300))
                let window = DriverPointerWindow(pid: pid_t(numeric(input["pid"], 321)),
                    windowID: UInt32(numeric(input["windowID"], 42)), bounds: bounds,
                    json: ["windowId": "42", "pid": 321, "processStart": "fake-start"])
                let geometry: DriverPointerGeometry? = input["noGeometry"] as? Bool == true ? nil :
                    DriverPointerGeometry(bounds: rectangle(input["captureBounds"], bounds),
                        pixelWidth: numeric(input["pixelWidth"], 800), pixelHeight: numeric(input["pixelHeight"], 600))
                let context = DriverPointerContext(window: window, geometry: geometry,
                    validateRead: {
                        readChecks += 1
                        if input["readId"] as? Int != 7 { throw DriverPointer.fault("STALE_READ", "Fake stale read.") }
                    }, resolveElement: { target in
                        resolves += 1
                        if let code = input["resolveError"] as? String { throw DriverPointer.fault(code, "Fake element refusal.") }
                        return rectangle(input["elementFrame"], CGRect(x: -180, y: 120, width: 40, height: 20))
                    }, checkBeforePost: {
                        let index = checks; checks += 1
                        if input["failCheckAt"] as? Int == index {
                            let code = input["checkError"] as? String ?? "IDENTITY_CHANGED"
                            throw DriverPointerFault(code: code, message: "Fake guard refusal.", personTookOver: code == "PERSON_TOOK_OVER")
                        }
                    }, checkReleaseIdentity: {
                        releaseChecks += 1
                        if input["releaseIdentityChanged"] as? Bool == true {
                            throw DriverPointer.fault("IDENTITY_CHANGED", "Fake recycled PID.")
                        }
                    }, remaining: { numeric(input["remaining"], 30) - waits.reduce(0, +) }, wait: { delay in
                        waits.append(delay)
                        if let flags = input["sourceFlagsAfterDown"] as? UInt64 { nativeSink.prepared?.sourceFlags = { CGEventFlags(rawValue: flags) } }
                        if let flags = input["releaseFlagsAfterDown"] as? UInt64 { nativeSink.prepared?.releases[0]?.flags = CGEventFlags(rawValue: flags) }
                        if input["failWaitAt"] as? Int == waits.count - 1 {
                            throw DriverPointer.fault("DEADLINE_EXCEEDED", "Fake elapsed deadline.")
                        }
                    }, admitInput: { admissions += 1 })
                var output: [String: Any]
                do {
                    let method = input["method"] as? String ?? "click"
                    let args = input["args"] as? [Any] ?? []
                    if input["dumpNative"] as? Bool == true {
                        // Construct and inspect CGEvents only. Never send to the fabricated PID.
                        let steps = try DriverPointer.plan(method: method, args: args, context: context)
                        let prepared = try DriverPointerNativeSink().prepare(steps, window: window) as! DriverPointerNativeSink.Prepared
                        if let flags = input["eventFlags"] as? UInt64 { prepared.events[0].flags = CGEventFlags(rawValue: flags) }
                        if let flags = input["sourceFlags"] as? UInt64 { prepared.sourceFlags = { CGEventFlags(rawValue: flags) } }
                        for index in prepared.events.indices { try prepared.validate(index) }
                        if input["validateRelease"] as? Bool == true {
                            if let flags = input["releaseFlags"] as? UInt64 { prepared.releases[0]!.flags = CGEventFlags(rawValue: flags) }
                            try prepared.validateEvent(prepared.releases[0]!)
                        }
                        let getLocation = unsafeBitCast(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventGetWindowLocation")!,
                                                        to: DriverPointerNativeSink.GetLocation.self)
                        let dump: (CGEvent) -> [String: Any] = { e in
                            ["type": e.type.rawValue, "point": [e.location.x, e.location.y], "flags": e.flags.rawValue,
                             "local": [getLocation(e).x, getLocation(e).y],
                             "pid": e.getIntegerValueField(.eventTargetUnixProcessID),
                             "source": e.getIntegerValueField(.eventSourceStateID),
                             "subtype": e.getIntegerValueField(.mouseEventSubtype),
                             "count": e.getIntegerValueField(.mouseEventClickState),
                             "button": e.getIntegerValueField(.mouseEventButtonNumber),
                             "window91": e.getIntegerValueField(CGEventField(rawValue: 91)!),
                             "window92": e.getIntegerValueField(CGEventField(rawValue: 92)!),
                             "vertical": e.getIntegerValueField(.scrollWheelEventPointDeltaAxis1),
                             "horizontal": e.getIntegerValueField(.scrollWheelEventPointDeltaAxis2)]
                        }
                        output = ["ok": true, "native": prepared.events.map(dump), "releaseCount": prepared.releases.count,
                                  "sourceID": prepared.source.sourceStateID.rawValue]
                    } else {
                        output = ["ok": true, "result": try DriverPointer.perform(method: method, args: args, context: context, sink: input["performNative"] as? Bool == true ? nativeSink : sink)]
                    }
                } catch let error as DriverPointerFault { output = ["ok": false, "error": error.json] }
                output["posts"] = sink.posted; output["releases"] = sink.released
                output["checks"] = checks; output["readChecks"] = readChecks
                output["resolves"] = resolves; output["releaseChecks"] = releaseChecks
                output["prepareCount"] = sink.prepareCount; output["waits"] = waits
                output["admissions"] = admissions; output["nativePosts"] = pointerTestPosts
                let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
                print(String(decoding: data, as: UTF8.self))
            } catch { fputs("Invalid fixture input.\n", stderr); exit(65) }
        }
    }
}
`;

before(async () => {
  if (!darwin) return;
  const directory = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-pointer-unit-')));
  const main = join(directory, 'PointerFixture.swift');
  executable = join(directory, 'pointer-fixture');
  writeFileSync(main, fixture);
  const mutation = process.env.UC2C_POINTER_MUTATION;
  let text = readFileSync(source, 'utf8');
  if (mutation) {
    const variants = {
      source: ['guard sourceFlags().isEmpty else', 'guard true else'],
      event: ['guard event.flags.isEmpty else', 'guard true else'],
      cleanup: ['try send(event, cleanup: true)', 'try send(event)'],
      admission: ['try prepared.validate(index)\n                try context.admitInput()',
        'try context.admitInput()\n                try prepared.validate(index)'],
    };
    assert.ok(variants[mutation], 'closed pointer mutation');
    const [from, to] = variants[mutation];
    assert.equal(text.split(from).length, 2);
    text = text.replace(from, to);
  }
  // This temporary source is the only native sink the fixture can execute.
  assert.equal(text.split('event.postToPid(pid)').length, 2);
  text = text.replace('event.postToPid(pid)', 'pointerTestPost(event, pid)');
  const pointerSource = join(directory, 'OfflinePointer.swift');
  writeFileSync(pointerSource, text);
  const compile = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_POINTER_STANDALONE', '-parse-as-library',
    '-module-cache-path', join(directory, 'module-cache'), pointerSource, main, '-o', executable],
  { killSignal: 'SIGKILL', timeout: 240000, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || String(compile.error));
});

function run(input = {}) {
  const result = spawnSync(executable, [], {
    input: JSON.stringify({ method: 'click', readId: 7, args: [[80, 120]], ...input }) + '\n',
    killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return JSON.parse(result.stdout);
}

function refusal(input, code) {
  const reply = run(input);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, code);
  assert.equal(reply.error.delivery, 'not-sent');
  assert.equal(reply.error.retry, 'safe');
  assert.equal(reply.admissions, 0);
  assert.deepEqual(reply.posts, []);
  return reply;
}

nativeTest('native flag guard refuses private-source modifiers and every unexpected event bit without posting', () => {
  for (const bit of [1, 0x10000, 0x20000, 0x40000, 0x80000, 0x100000, 0x200000, 0x80000000]) {
    for (const key of ['sourceFlags', 'eventFlags', 'releaseFlags']) {
      const reply = run({ dumpNative: true, validateRelease: true, [key]: bit });
      assert.equal(reply.ok, false, key + ':' + bit);
      assert.equal(reply.error.code, key === 'sourceFlags' ? 'PERSON_HOLDS_MODIFIER' : 'EVENT_BUILD_FAILED');
      assert.equal(reply.error.delivery, 'not-sent');
      assert.deepEqual(reply.posts, []);
    }
  }
  assert.equal(run({ dumpNative: true, sourceFlags: 0, eventFlags: 0, releaseFlags: 0, validateRelease: true }).ok, true);
});

nativeTest('dispatch flag refusal happens before input admission or any post', () => {
  const reply = refusal({ failValidateAt: 0 }, 'EVENT_BUILD_FAILED');
  assert.deepEqual(reply.releases, []);
  assert.equal(reply.releaseChecks, 0);
});

nativeTest('cleanup releases our own button despite source or release flags that refuse a press', () => {
  for (const key of ['sourceFlagsAfterDown', 'releaseFlagsAfterDown']) {
    const reply = run({ performNative: true, [key]: 0x100000, failWaitAt: 0 });
    assert.equal(reply.ok, false);
    assert.equal(reply.error.buttonCleanup, 'released', key);
    assert.equal(reply.error.unhealthy, false);
    assert.equal(reply.releaseChecks, 1);
    assert.deepEqual(reply.nativePosts.map(e => e.type), [1, 2]);
    assert.ok(reply.nativePosts.every(e => e.pid === 321));
  }
  // The ordinary up is refused by changed source flags, then cleanup still posts up.
  const reply = run({ performNative: true, sourceFlagsAfterDown: 0x100000 });
  assert.equal(reply.error.code, 'PERSON_HOLDS_MODIFIER');
  assert.equal(reply.error.buttonCleanup, 'released');
  assert.deepEqual(reply.nativePosts.map(e => e.type), [1, 2]);
  const recycled = run({ performNative: true, sourceFlagsAfterDown: 0x100000, releaseIdentityChanged: true });
  assert.equal(recycled.error.buttonCleanup, 'unconfirmed');
  assert.deepEqual(recycled.nativePosts.map(e => e.type), [1]);
});

nativeTest('stdin fake: click maps Retina screenshot pixels to global points', () => {
  const reply = run();
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.posts.map(e => [e.type, e.point, e.count, e.button]), [[1, [-160, 160], 1, 0], [2, [-160, 160], 1, 0]]);
  assert.equal(reply.checks, 3);
  assert.equal(reply.readChecks, 1);
  assert.equal(reply.resolves, 0);
  assert.equal(reply.result.delivery, 'sent-unverified');
  assert.equal(reply.result.retry, 'read-first');
  assert.equal(reply.result.settled, false);
  assert.equal(reply.result.personTookOver, false);
  assert.equal(reply.result.postedEvents, 2);
});

nativeTest('stdin fake: element center uses points without requiring a screenshot', () => {
  const reply = run({ args: [4], noGeometry: true });
  assert.equal(reply.ok, true);
  assert.equal(reply.resolves, 1);
  assert.deepEqual(reply.posts[0].point, [-160, 130]);
});

for (const target of [{ id: 'save' }, { label: 'Save' }, 0]) {
  nativeTest(`stdin fake: retained target ${JSON.stringify(target)}`, () => {
    const reply = run({ args: [target] });
    assert.equal(reply.ok, true); assert.equal(reply.resolves, 1);
  });
}

for (const [method, args, types, counts, buttons] of [
  ['doubleClick', [[80, 120]], [1, 2, 1, 2], [1, 1, 2, 2], [0, 0, 0, 0]],
  ['rightClick', [[80, 120]], [3, 4], [1, 1], [1, 1]],
  ['click', [[80, 120], { mouseButton: 'middle', clickCount: 3 }], [25, 26, 25, 26, 25, 26], [1, 1, 2, 2, 3, 3], [2, 2, 2, 2, 2, 2]],
  ['click', [[80, 120], { mouseButton: 'right', clickCount: 2 }], [3, 4, 3, 4], [1, 1, 2, 2], [1, 1, 1, 1]],
]) {
  nativeTest(`stdin fake: ${method} ${JSON.stringify(args[1] ?? {})}`, () => {
    const reply = run({ method, args });
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.posts.map(e => e.type), types);
    assert.deepEqual(reply.posts.map(e => e.count), counts);
    assert.deepEqual(reply.posts.map(e => e.button), buttons);
    assert.equal(reply.checks, types.length + 1);
  });
}

for (const [direction, distance, x, y] of [
  ['up', 2, 0, 600], ['down', 0.5, 0, -150], ['left', 1, 400, 0], ['right', { pixels: 123 }, -123, 0],
  ['up', { pixels: 0.1 }, 0, 1],
]) {
  nativeTest(`stdin fake: scroll ${direction} ${JSON.stringify(distance)}`, () => {
    const reply = run({ method: 'scroll', args: [[80, 120], direction, distance] });
    assert.equal(reply.ok, true);
    assert.equal(reply.posts.length, 1);
    assert.deepEqual([reply.posts[0].type, reply.posts[0].wheelX, reply.posts[0].wheelY], [22, x, y]);
  });
}

nativeTest('stdin fake: app.drag prepares 29 events and a stationary destination move', () => {
  const reply = run({ method: 'drag', args: [[80, 120], [400, 300]] });
  assert.equal(reply.ok, true);
  assert.equal(reply.posts.length, 29);
  assert.deepEqual(reply.posts.slice(0, 2).map(e => e.type), [5, 1]);
  assert.deepEqual(reply.posts.slice(-3).map(e => [e.type, e.point]), [[6, [0, 250]], [6, [0, 250]], [2, [0, 250]]]);
  assert.equal(reply.posts.filter(e => e.type === 6).length, 26);
  assert.deepEqual(reply.waits.slice(0, 2), [0.05, 0.5]);
  assert.equal(reply.waits.slice(2).length, 26);
  assert.ok(reply.waits.slice(2).every(delay => delay === 0.02));
  assert.deepEqual(reply.releases, []);
});

nativeTest('stdin fake: both drag endpoints resolve before preparing or sending', () => {
  const reply = run({ method: 'drag', args: [4, { id: 'end' }] });
  assert.equal(reply.resolves, 2);
  assert.equal(reply.prepareCount, 1);
  const rejected = refusal({ method: 'drag', args: [4, { id: 'end' }], resolveError: 'ELEMENT_NOT_FOUND' }, 'ELEMENT_NOT_FOUND');
  assert.equal(rejected.prepareCount, 0);
});

nativeTest('stdin fake: malformed arguments refuse before resolving or preparing', () => {
  const cases = [
    { args: [] }, { args: [1, {}, 'extra'] }, { args: [1, null] }, { args: [1, []] },
    { args: [1, { button: 'right' }] }, { args: [1, { mouseButton: 'other' }] },
    { args: [1, { key: ['meta'] }] }, { args: [1, { modifiers: ['command'] }] },
    { args: [1, { clickCount: true }] }, { args: [1, { clickCount: 0 }] },
    { args: [1, { clickCount: 4 }] }, { args: [1, { clickCount: 1.5 }] },
    ...[true, -1, 0.5, 9_007_199_254_740_992, null, '1', [], [1], [1, 2, 3], [true, 2], {},
      { id: '' }, { label: '' }, { id: 'x', label: 'x' }, { id: 'x', extra: 1 }, { id: 42 }].map(target => ({ args: [target] })),
    { method: 'doubleClick', args: [1, {}] }, { method: 'rightClick', args: [] },
    { method: 'drag', args: [1] }, { method: 'drag', args: [1, false] },
    ...[['sideways', 1], ['up', 0], ['up', -1], ['up', true], ['up', 101], ['up', {}],
      ['up', { pixels: 0 }], ['up', { pixels: 100001 }], ['up', { pixels: 3, pages: 1 }]].map(tail => ({ method: 'scroll', args: [1, ...tail] })),
  ];
  for (const input of cases) {
    const reply = refusal(input, 'INVALID_PARAMS');
    assert.equal(reply.resolves, 0); assert.equal(reply.prepareCount, 0);
  }
});

nativeTest('stdin fake: unknown methods and unverified window metadata refuse', () => {
  refusal({ method: 'hover' }, 'METHOD_NOT_FOUND');
  for (const extra of [{ pid: 0 }, { windowID: 0 }, { bounds: [0, 0, 0, 300] }, { bounds: [0, 0, 400, -1] }]) {
    refusal(extra, 'IDENTITY_UNVERIFIED');
  }
});

nativeTest('stdin fake: stale read refuses coordinate and element targets before preparation', () => {
  for (const args of [[[80, 120]], [4]]) {
    const reply = refusal({ args, readId: 6 }, 'STALE_READ');
    assert.equal(reply.prepareCount, 0); assert.equal(reply.resolves, 0);
  }
});

nativeTest('stdin fake: coordinate input needs current matching screenshot geometry', () => {
  refusal({ captureBounds: [-199, 100, 400, 300] }, 'IDENTITY_CHANGED');
  for (const extra of [{ noGeometry: true },
    { pixelWidth: 0 }, { pixelHeight: -1 }]) refusal(extra, 'CAPTURE_GEOMETRY_REQUIRED');
  for (const extra of [{ pixelWidth: 1601 }, { pixelWidth: 99 }, { pixelHeight: 300 }]) {
    refusal(extra, 'CAPTURE_SCALE_MISMATCH');
  }
});

nativeTest('stdin fake: coordinate and element centers must be inside the bound window', () => {
  for (const pair of [[-1, 10], [10, -1], [800, 10], [10, 600]]) {
    refusal({ args: [pair] }, 'POINT_OUTSIDE_WINDOW');
  }
  refusal({ args: [4], elementFrame: [300, 100, 20, 20] }, 'POINT_OUTSIDE_WINDOW');
  refusal({ args: [4], elementFrame: [-180, 120, 0, 20] }, 'ELEMENT_UNAVAILABLE');
});

nativeTest('stdin fake: liveness and ambiguity errors do not send input', () => {
  for (const code of ['ELEMENT_NOT_FOUND', 'AMBIGUOUS_ELEMENT', 'ELEMENT_STALE', 'IDENTITY_CHANGED']) {
    refusal({ args: [4], resolveError: code }, code);
  }
});

nativeTest('stdin fake: preparation failure does not post even the first down', () => {
  const reply = refusal({ failPrepare: true }, 'EVENT_BUILD_FAILED');
  assert.deepEqual(reply.releases, []);
});

nativeTest('stdin fake: guard refusal immediately before down reports safe retry', () => {
  for (const code of ['IDENTITY_CHANGED', 'DEADLINE_EXCEEDED', 'PERSON_TOOK_OVER']) {
    const reply = refusal({ failCheckAt: 0, checkError: code }, code);
    assert.equal(reply.error.personTookOver, code === 'PERSON_TOOK_OVER');
    assert.deepEqual(reply.releases, []);
  }
});

nativeTest('stdin fake: deadline reserves the entire sequence and a release margin before down', () => {
  refusal({ remaining: 0.1 }, 'DEADLINE_EXCEEDED');
  refusal({ method: 'drag', args: [[80, 120], [400, 300]], remaining: 1.1 }, 'DEADLINE_EXCEEDED');
});

nativeTest('stdin fake: takeover after the final up prevents a clean completion claim', () => {
  const reply = run({ failCheckAt: 2, checkError: 'PERSON_TOOK_OVER' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.personTookOver, true);
  assert.equal(reply.error.delivery, 'unknown');
  assert.deepEqual(reply.releases, []);
});

nativeTest('stdin fake: uncertain down always attempts its prebuilt up', () => {
  const reply = run({ failPostAt: 0 });
  assert.equal(reply.error.delivery, 'unknown');
  assert.equal(reply.admissions, 1);
  assert.equal(reply.error.retry, 'read-first');
  assert.equal(reply.error.buttonCleanup, 'released');
  assert.equal(reply.releaseChecks, 1);
  assert.deepEqual(reply.releases.map(e => [e.type, e.point]), [[2, [-160, 160]]]);
});

nativeTest('stdin fake: person takeover before up stops dispatch and releases only', () => {
  const reply = run({ failCheckAt: 1, checkError: 'PERSON_TOOK_OVER' });
  assert.equal(reply.error.personTookOver, true);
  assert.equal(reply.posts.length, 1);
  assert.equal(reply.releases.length, 1);
  assert.equal(reply.error.delivery, 'unknown');
});

nativeTest('stdin fake: expired hold releases without another regular post', () => {
  const reply = run({ method: 'drag', args: [[80, 120], [400, 300]], failWaitAt: 1 });
  assert.equal(reply.error.code, 'DEADLINE_EXCEEDED');
  assert.equal(reply.posts.length, 2);
  assert.equal(reply.releases[0].type, 2);
  assert.equal(reply.error.buttonCleanup, 'released');
});

nativeTest('stdin fake: failed drag movement releases at the attempted current point', () => {
  const reply = run({ method: 'drag', args: [[80, 120], [400, 300]], failPostAt: 10 });
  assert.deepEqual(reply.releases[0].point, reply.posts.at(-1).point);
  assert.equal(reply.releases[0].type, 2);
});

nativeTest('stdin fake: recycled PID or failed release leaves cleanup unconfirmed', () => {
  for (const extra of [{ releaseIdentityChanged: true }, { failRelease: true }]) {
    const reply = run({ failPostAt: 0, ...extra });
    assert.equal(reply.error.delivery, 'unknown');
    assert.equal(reply.error.buttonCleanup, 'unconfirmed');
    assert.equal(reply.error.unhealthy, true);
    assert.deepEqual(reply.releases, []);
  }
});

nativeTest('stdin fake: completed up clears pending state before a later failure', () => {
  const reply = run({ method: 'doubleClick', failWaitAt: 1 });
  assert.equal(reply.posts.length, 2);
  assert.equal(reply.error.buttonCleanup, 'not-needed');
  assert.deepEqual(reply.releases, []);
});

for (const [method, args] of [
  ['click', [[80, 120]]], ['doubleClick', [[80, 120]]], ['rightClick', [[80, 120]]],
  ['click', [[80, 120], { mouseButton: 'middle', clickCount: 3 }]],
  ['scroll', [[80, 120], 'up', { pixels: 123 }]], ['scroll', [[80, 120], 'right', { pixels: 77 }]],
  ['drag', [[80, 120], [400, 300]]],
]) {
  nativeTest(`native dump without dispatch: ${method} ${JSON.stringify(args[1] ?? {})}`, () => {
    const reply = run({ method, args, dumpNative: true });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.deepEqual(reply.posts, []);
    assert.equal(reply.checks, 0);
    for (const event of reply.native) {
      assert.equal(event.source, reply.sourceID);
      assert.notEqual(event.source, 0);
      assert.notEqual(event.source, 1);
      assert.equal(event.flags, 0);
      assert.equal(event.pid, 321);
      assert.deepEqual(event.local, [event.point[0] + 200, event.point[1] - 100]);
      assert.equal(event.subtype, method === 'scroll' ? 0 : 3);
      assert.equal(event.window91, method === 'scroll' ? 0 : 42);
      assert.equal(event.window92, method === 'scroll' ? 0 : 42);
    }
    if (method === 'scroll') {
      assert.equal(reply.native[0].vertical, args[1] === 'up' ? 123 : 0);
      assert.equal(reply.native[0].horizontal, args[1] === 'right' ? -77 : 0);
    } else if (method !== 'drag') {
      const button = method === 'rightClick' ? 1 : args[1]?.mouseButton === 'middle' ? 2 : 0;
      const counts = method === 'doubleClick' ? [1, 1, 2, 2]
        : args[1]?.clickCount === 3 ? [1, 1, 2, 2, 3, 3] : [1, 1];
      assert.deepEqual(reply.native.map(event => event.count), counts);
      assert.ok(reply.native.every(event => event.button === button));
    }
  });
}

test('native sender has only pid posts and no pointer, app activation or HID-tap path', () => {
  const text = readFileSync(source, 'utf8');
  assert.match(text, /stateID: \.privateState/);
  assert.match(text, /event\.postToPid\(pid\)/);
  assert.doesNotMatch(text, /CGWarpMouseCursorPosition|CGAssociateMouseAndMouseCursorPosition|\.post\(tap:|\.cghidEventTap|\.activate\(|NSApplication\.shared|NSWorkspace\.shared/);
});
