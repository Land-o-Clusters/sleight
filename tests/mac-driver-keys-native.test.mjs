import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { keyPlan, textPlan } from '../plugins/sleight/lib/mac-driver/keys.mjs';

// Only the OS boundary is fake. This entry point never creates NSApplication,
// enumerates real apps, reads the active input source or posts an event.
const harness = String.raw`
import Foundation
import ApplicationServices

let driverProtocol = "sleight.driver/1"
final class DriverRequest {
    let params: DriverObject; let method: String
    init(_ value: DriverObject) { params = value["params"] as? DriverObject ?? [:]; method = value["method"] as? String ?? "" }
    func keys(_ required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(params.keys)), Set(params.keys).isSubset(of: required.union(optional)) else { throw DriverFault("INVALID_PARAMS") }
    }
    func check() throws { if expired { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) } }
    var remaining: Double { 1 }
    var inputAdmitted = false
    func admitInput() throws { inputAdmitted = true }
    func checkClipboardAdmission() throws {}
    // RT32's action event feed is off in this fixture, as in production with no consumer.
    let actionEvent: FakeActionEvent? = nil
    let inputRelease: DriverInputRelease? = nil
}
final class FakeActionEvent { func prepare(window: DriverObject) {} }
struct FakeRoot { func same(_ other: FakeRoot) -> Bool { true } }
struct DriverReadMap { let id = 1; let processStart = "start"; let root = FakeRoot(); let text: String? = "tree"; let truncated = false }
struct DriverBoundWindow { let window: DriverObject; let root = FakeRoot() }
final class DriverInventory {
    var changed = false
    var fixture: DriverObject? = [:]
    func bound(_ params: DriverObject) throws -> DriverObject {
        if changed || params["windowId"] as? String != "7" || params["processStart"] as? String != "start" { throw DriverFault("IDENTITY_CHANGED") }
        return ["windowId": "7", "processStart": "start", "pid": 42, "identityVerified": true]
    }
}
final class DriverCore {
    let inventory = DriverInventory(); var maps = ["7": DriverReadMap()]
    func boundWindow(_ params: DriverObject, request: DriverRequest) throws -> DriverBoundWindow { DriverBoundWindow(window: try inventory.bound(params)) }
    func readTree(_ params: DriverObject, request: DriverRequest) throws -> DriverObject { [:] }
}
final class DriverRuntime {
    let inputRelease = DriverInputRelease()
    var releaseHeldInput: () throws -> Void = {}
    typealias Handler = (DriverRequest, DriverCore) throws -> DriverObject
    var handlers: [String: Handler] = [:]
    func register(method: String, handler: @escaping Handler) { handlers[method] = handler }
    func registerAction(method: String, handler: @escaping Handler,
        afterObservation: ((DriverRequest, DriverCore, DriverObject) throws -> DriverObject)? = nil) { handlers[method] = handler }
}
let core = DriverCore(), runtime = DriverRuntime()
var emitted = [DriverObject](), prepared = 0, attempted = 0, guards = 0
var control: DriverObject = [:]
var expired = false
var activeLayout: [String: DriverKeyboardMapping] = [:]
let keyboard = DriverKeyboard(layout: { activeLayout }, makeEvent: { spec in
    prepared += 1
    if prepared == driverInteger(control["failPrepare"]) { throw DriverKeyboardIssue("EVENT_CREATE_FAILED") }
    return { pid in
        attempted += 1
        if attempted == driverInteger(control["failPost"]) { throw DriverKeyboardIssue("POST_FAILED") }
        var row = spec.json; row["pid"] = Int(pid); emitted.append(row)
    }
}, ladder: { control["strategy"] as? String }, pause: { if control["expireAfterPause"] as? Bool == true { expired = true } }, beforeInput: { _, _ in
    guards += 1
    if guards == driverInteger(control["expireAtGuard"]) { expired = true }
    let point: String
    if emitted.isEmpty { point = "initial-input" }
    else if emitted.last?["type"] as? String == "flagsChanged", driverInteger(emitted.last?["keyCode"]) == 55 { point = "after-meta-down" }
    else if emitted.last?["type"] as? String == "flagsChanged", driverInteger(emitted.last?["keyCode"]) == 56,
            driverInteger(emitted.last?["flags"]) == 0 { point = "after-shift-up" }
    else { point = "later-input" }
    let takeover = keyboardMutation == "ordinal-guard"
        ? guards == 2 && control["takeoverWhen"] as? String == "after-meta-down"
        : point == control["takeoverWhen"] as? String
    if takeover { throw DriverFault("PERSON_TOOK_OVER") }
    if point == control["identityWhen"] as? String { core.inventory.changed = true }
})
keyboard.register(in: runtime, fault: { $0 })
while let line = readLine() {
    do {
        let value = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! DriverObject
        control = value["control"] as? DriverObject ?? [:]
        emitted = []; prepared = 0; attempted = 0; guards = 0; expired = false; core.inventory.changed = false
        if let layout = value["layout"] as? DriverObject {
            activeLayout = [:]
            for (char, raw) in layout {
                let map = raw as! DriverObject
                activeLayout[char] = DriverKeyboardMapping(keyCode: driverInteger(map["keyCode"])!, modifiers: map["modifiers"] as? [String] ?? [])
            }
        }
        let request = DriverRequest(value)
        let result: DriverObject
        if control["nativeTransport"] as? Bool == true {
            result = try DriverKeyboard(beforeInput: { _, _ in throw DriverFault("UNEXPECTED_NATIVE_GUARD") }).handle(request, core: core)
        } else { result = try runtime.handlers[request.method]!(request, core) }
        let out: DriverObject = ["ok": true, "result": result, "events": emitted, "attempted": attempted, "prepared": prepared]
        print(String(data: try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
    } catch {
        let fault = error as? DriverKeyboardFault
        let out: DriverObject = ["ok": false, "error": fault?.json ?? ["code": (error as? DriverFault)?.code ?? "UNKNOWN"], "events": emitted, "attempted": attempted, "prepared": prepared]
        print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
`;
const binding = { windowId: '7', processStart: 'start', readId: 1 };
const layout = { a: { keyCode: 12, modifiers: [] }, A: { keyCode: 12, modifiers: ['shift'] }, q: { keyCode: 0, modifiers: [] }, s: { keyCode: 1, modifiers: [] }, g: { keyCode: 5, modifiers: [] }, '+': { keyCode: 24, modifiers: ['shift'] }, '@': { keyCode: 19, modifiers: ['alt'] } };
const request = (method, args, extra = {}) => ({ method, params: { ...binding, args }, layout, ...extra });

test('Swift keyboard dispatch over stdin with fake layout and sink', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-keyboard-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'keyboard.swift'), binary = join(root, 'keyboard');
  const codes = 'let keyboardMutation = CommandLine.arguments.dropFirst().first ?? "none"\nlet driverErrorCodes: [String: (next: String, unhealthy: Bool)] = [\n' +
    Object.entries(DRIVER_CODES).map(([code, row]) => `"${code}": ("${row.next}", ${row.unhealthy})`).join(',\n') + '\n]\n';
  let keyboard = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverKeyboard.swift', import.meta.url), 'utf8');
  for (const [from, to] of [
    ['if sent > 0 || uncertain {', 'if sent > 0 || uncertain || keyboardMutation == "release-inherited" && !held.isEmpty {'],
    ['cleanup = []\n            try beforeInput', 'cleanup = keyboardMutation == "release-inherited" ? try Self.releases(pending).map(makeEvent) : []\n            try beforeInput'],
  ]) {
    assert.ok(keyboard.includes(from), `missing mutation anchor: ${from}`);
    keyboard = keyboard.replace(from, to);
  }
  await writeFile(source, codes + await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverStop.swift', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverValues.swift', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverFocusBelief.swift', import.meta.url), 'utf8') + '\n' + keyboard + '\n' + harness);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536 });
  assert.equal(compile.status, 0, compile.stderr);
  t.diagnostic(`binaryBytes=${(await stat(binary)).size}`);
  const run = (rows, variant) => {
    const result = spawnSync(binary, variant ? [variant] : [], { input: rows.map(JSON.stringify).join('\n') + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout.trim().split('\n').map(JSON.parse);
  };
  await t.test('mapped chords, bare modifiers, named keys and ladder match the pure planner', () => {
    for (const chord of ['super+s', 'cmd+shift+g', 'control+alt', 'A', 'q', 'ctrl+Page_Down', 'F12', 'plus', 'alt+at']) {
      for (const strategy of ['flags-changed', 'flags-only', 'key-events']) {
        const [reply] = run([request('pressKey', [chord], { control: { strategy } })]);
        assert.equal(reply.ok, true, JSON.stringify(reply));
        assert.deepEqual(reply.events, keyPlan(chord, new Map(Object.entries(layout)), { strategy }).map(e => ({ ...e, pid: 42 })));
        assert.equal(reply.result.delivery, 'sent-unverified'); assert.equal(reply.result.retry, 'read-first');
      }
    }
  });
  await t.test('text at the caret uses mapped keys and Unicode chunks with no target', () => {
    for (const text of ['aA@', '界'.repeat(31) + '🪄' + '界'.repeat(34), 'a\n\tq', '']) {
      const [reply] = run([request('typeText', [text])]);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.deepEqual(reply.events, textPlan(text, new Map(Object.entries(layout))).map(e => ({ ...e, pid: 42 })));
      assert.equal(reply.result.delivery, text ? 'sent-unverified' : 'not-sent');
    }
  });
  await t.test('all arguments validate before preparing an event or accessing the sink', () => {
    const rows = [request('pressKey', ['ctrl+s+a']), request('pressKey', ['s', {}]), request('typeText', [1]), request('typeText', ['a\0b']), request('pressKey', ['constructor']), request('modifiers', [{ keys: ['shift', 'shift'], state: 'down' }]), request('pressKey', ['s'], { control: { strategy: 'all' } })];
    for (const reply of run(rows)) {
      assert.equal(reply.ok, false); assert.equal(reply.error.code, 'INVALID_PARAMS'); assert.equal(reply.attempted, 0); assert.equal(reply.prepared, 0);
    }
  });
  await t.test('stale read, changed binding and pre-input takeover refuse without delivery', () => {
    const rows = [request('pressKey', ['s'], { params: { ...binding, readId: 2, args: ['s'] } }), request('pressKey', ['s'], { params: { ...binding, processStart: 'other', args: ['s'] } }), request('pressKey', ['s'], { control: { takeoverWhen: 'initial-input' } })];
    const replies = run(rows);
    assert.deepEqual(replies.map(r => r.error.code), ['STALE_READ', 'IDENTITY_CHANGED', 'PERSON_TOOK_OVER']);
    for (const reply of replies) { assert.equal(reply.events.length, 0); assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.error.retry, 'safe'); }
  });
  await t.test('every event and cleanup release is prepared before the first post', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { failPrepare: 3 } })]);
    assert.equal(reply.error.code, 'EVENT_CREATE_FAILED'); assert.equal(reply.attempted, 0); assert.equal(reply.error.delivery, 'not-sent');
  });
  await t.test('mid-chord takeover releases pending modifier and never sends the character', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { takeoverWhen: 'after-meta-down' } })]);
    assert.equal(reply.error.code, 'PERSON_TOOK_OVER'); assert.equal(reply.error.delivery, 'sent-unverified');
    assert.deepEqual(reply.events.map(e => [e.type, e.keyCode, e.flags]), [['flagsChanged', 55, 1048576], ['flagsChanged', 55, 0]]);
  });
  await t.test('an uncertain post cleans up key and modifiers without replaying', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { failPost: 2 } })]);
    assert.equal(reply.error.delivery, 'unknown'); assert.equal(reply.error.retry, 'read-first');
    assert.deepEqual(reply.events.map(e => [e.type, e.keyCode]), [['flagsChanged', 55], ['keyUp', 1], ['flagsChanged', 55]]);
  });
  await t.test('held modifiers persist only for the exact binding and release explicitly', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]), request('pressKey', ['s']), request('modifiers', [{ keys: ['shift'], state: 'up' }])]);
    assert.deepEqual(replies[0].events.map(e => [e.keyCode, e.flags]), [[56, 131072]]);
    assert.deepEqual(replies[1].events.map(e => [e.type, e.keyCode, e.flags]), [['keyDown', 1, 131072], ['keyUp', 1, 131072]]);
    assert.deepEqual(replies[2].events.map(e => [e.keyCode, e.flags]), [[56, 0]]);
  });
  await t.test('held state refuses text and a different window without sending', () => {
    const replies = run([request('modifiers', [{ keys: ['meta'], state: 'down' }]), request('typeText', ['a']), request('pressKey', ['s'], { params: { ...binding, windowId: '8', args: ['s'] } }), request('modifiers', [{ keys: ['meta'], state: 'up' }])]);
    assert.equal(replies[1].error.code, 'MODIFIERS_HELD'); assert.equal(replies[2].error.code, 'MODIFIER_BINDING_CHANGED');
    assert.equal(replies[1].events.length, 0); assert.equal(replies[2].events.length, 0); assert.equal(replies[3].ok, true);
  });
  await t.test('a pre-input takeover preserves modifiers held by an earlier call', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]), request('pressKey', ['s'], { control: { takeoverWhen: 'initial-input' } }), request('pressKey', ['s']), request('modifiers', [{ keys: ['shift'], state: 'up' }])]);
    assert.equal(replies[1].error.code, 'PERSON_TOOK_OVER');
    assert.deepEqual(replies[1].events, []);
    assert.equal(replies[1].error.delivery, 'not-sent');
    assert.deepEqual(replies[2].events.map(e => e.flags), [131072, 131072]);
    assert.deepEqual(replies[3].events.map(e => e.flags), [0]);
  });
  await t.test('mid-chord cleanup releases only this call downs and preserves earlier modifier flags', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]),
      request('pressKey', ['super+s'], { control: { takeoverWhen: 'after-meta-down' } }), request('pressKey', ['s'])]);
    assert.deepEqual(replies[1].events.map(e => [e.type, e.keyCode, e.flags]),
      [['flagsChanged', 55, 1179648], ['flagsChanged', 55, 131072]]);
    assert.deepEqual(replies[2].events.map(e => e.flags), [131072, 131072]);
  });
  await t.test('an explicit earlier hold release remains released if a person interrupts after its key up', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]),
      request('modifiers', [{ keys: ['shift'], state: 'up' }], { control: { takeoverWhen: 'after-shift-up' } }), request('pressKey', ['s'])]);
    assert.equal(replies[1].error.code, 'PERSON_TOOK_OVER');
    assert.deepEqual(replies[1].events.map(e => [e.keyCode, e.flags]), [[56, 0]]);
    assert.deepEqual(replies[2].events.map(e => e.flags), [0, 0]);
  });
  await t.test('a failed cleanup is unknown and does not strand later calls in held state', () => {
    const replies = run([request('pressKey', ['super+s'], { control: { takeoverWhen: 'after-meta-down', failPost: 2 } }), request('pressKey', ['s'])]);
    assert.equal(replies[0].error.cleanupComplete, false); assert.equal(replies[0].error.delivery, 'unknown');
    assert.deepEqual(replies[1].events.map(e => e.flags), [0, 0]);
  });
  await t.test('repeated holds are idempotent and a bare pulse preserves an existing hold', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]), request('modifiers', [{ keys: ['shift'], state: 'down' }]), request('pressKey', ['shift']), request('modifiers', [{ keys: ['shift'], state: 'up' }])]);
    assert.equal(replies[1].events.length, 0); assert.equal(replies[1].result.delivery, 'not-sent');
    assert.equal(replies[2].events.length, 0); assert.deepEqual(replies[3].events.map(e => e.flags), [0]);
  });
  await t.test('a deadline expiring inside the guard stops before the next post', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { expireAtGuard: 1 } })]);
    assert.equal(reply.error.code, 'DEADLINE_EXCEEDED'); assert.equal(reply.error.unhealthy, true);
    assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.events.length, 0);
  });
  await t.test('expiry during final text pacing retains partial-delivery disposition', () => {
    const [reply] = run([request('typeText', ['a'], { control: { expireAfterPause: true } })]);
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'DEADLINE_EXCEEDED');
    assert.equal(reply.error.delivery, 'sent-unverified'); assert.equal(reply.error.retry, 'read-first');
    assert.deepEqual(reply.events.map(e => e.type), ['keyDown', 'keyUp']);
  });
  await t.test('a fixture cannot reach the native layout or posting adapters', () => {
    const [reply] = run([request('pressKey', ['s'], { control: { nativeTransport: true } })]);
    assert.equal(reply.error.code, 'KEYBOARD_FIXTURE_REQUIRES_FAKE');
    assert.equal(reply.error.delivery, 'not-sent'); assert.equal(reply.attempted, 0);
  });
  await t.test('each request uses a fresh layout snapshot', () => {
    const replies = run([request('pressKey', ['a']), request('pressKey', ['a'], { layout: { a: { keyCode: 0, modifiers: [] } } })]);
    assert.deepEqual(replies.map(r => r.events[0].keyCode), [12, 0]);
  });
  await t.test('broken variant detected: cleanup releases an earlier call modifier during person refusal', () => {
    const replies = run([request('modifiers', [{ keys: ['shift'], state: 'down' }]),
      request('pressKey', ['s'], { control: { takeoverWhen: 'initial-input' } })], 'release-inherited');
    assert.notDeepEqual(replies[1].events, []);
    assert.equal(replies[1].events[0].keyCode, 56);
  });
  await t.test('broken variant detected: ordinal guard fires before the named modifier-down boundary', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { takeoverWhen: 'after-meta-down' } })], 'ordinal-guard');
    assert.notDeepEqual(reply.events.map(e => [e.type, e.keyCode, e.flags]),
      [['flagsChanged', 55, 1048576], ['flagsChanged', 55, 0]]);
    assert.equal(reply.error.delivery, 'not-sent');
  });
  await t.test('PID identity change during a chord stops before the next post', () => {
    const [reply] = run([request('pressKey', ['super+s'], { control: { identityWhen: 'after-meta-down' } })]);
    assert.equal(reply.error.code, 'IDENTITY_CHANGED'); assert.equal(reply.error.retry, 'read-first');
    assert.equal(reply.events.length, 1); // Never release into a reused PID.
  });
});
