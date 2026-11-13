import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { textPlan } from '../plugins/sleight/lib/mac-driver/keys.mjs';
import { DRIVER_CODES } from '../plugins/sleight/lib/mac-driver/protocol.mjs';

const payload = 'café 日本 🙂';
test('Unicode-only text plans carry exact scalars and zero flags independently of the layout', () => {
  for (const text of ['aA@', payload, 'e\u0301'.repeat(40), 'x'.repeat(2000)]) {
    const events = textPlan(text, new Map([['A', { keyCode: 0, modifiers: ['shift'] }]]), { unicodeOnly: true });
    assert.equal(events.filter(e => e.type === 'keyDown').map(e => e.unicode).join(''), text);
    for (const event of events) {
      assert.equal(event.flags, 0); assert.equal(event.keyCode, 0);
      assert.ok(['keyDown', 'keyUp'].includes(event.type));
      assert.ok(event.unicode.length <= 32); assert.ok(event.unicode.isWellFormed());
    }
  }
  for (const text of ['a\nb', 'a\rb', 'a\tb']) assert.throws(() => textPlan(text, new Map(), { unicodeOnly: true }), { code: 'ACTION_UNSUPPORTED' });
});

const harness = String.raw`
let config = try! DriverJSON.decode(Data(readLine()!.utf8))
let mode = config["case"] as? String ?? "exact"
let requested = config["text"] as? String ?? "café 日本 🙂"
if mode.hasPrefix("adapter-") {
    var valueReads = 0, copies = 0
    var selected = CFRange(location: 0, length: 0)
    let selectedValue = AXValueCreate(.cfRange, &selected)!
    let access = DriverTextAccess(application: { _ in "app" as CFString },
        isElement: { CFGetTypeID($0) == CFStringGetTypeID() },
        pid: { _ in mode == "adapter-foreign" ? 99 : 42 },
        copy: { raw, name, _ in
            copies += 1
            let node = raw as! String
            if name == kAXFocusedUIElementAttribute { return "field" as CFString }
            if name == kAXRoleAttribute {
                return (node == "window" ? kAXWindowRole : node == "group" ? kAXGroupRole : mode == "adapter-role" ? kAXButtonRole : kAXTextFieldRole) as CFString
            }
            if name == kAXSubroleAttribute { return node == "group" && mode == "adapter-secure" ? "AXSecureTextField" as CFString : nil }
            if name == kAXEnabledAttribute { return mode == "adapter-disabled" ? kCFBooleanFalse : kCFBooleanTrue }
            if name == kAXParentAttribute { return (mode == "adapter-cycle" ? "field" : node == "field" ? "group" : "window") as CFString }
            if name == "AXWindowNumber" { return NSNumber(value: mode == "adapter-window" ? 8 : 7) }
            if name == kAXNumberOfCharactersAttribute { return NSNumber(value: mode == "adapter-size" ? 1_048_577 : 0) }
            if name == kAXValueAttribute { valueReads += 1; return mode == "adapter-no-value" ? nil : "" as CFString }
            if name == kAXSelectedTextRangeAttribute { return selectedValue }
            return nil
        })
    var out: DriverObject
    do {
        let sampled = try DriverKeyboard.sampleTextSnapshot(42, "7", 1, true, access: access)
        out = ["ok": true, "hasValue": sampled.value != nil]
    } catch { out = ["ok": false, "error": ["code": (error as? DriverFault)?.code ?? "unexpected"]] }
    out["valueReads"] = valueReads; out["copies"] = copies
    print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!); exit(0)
}
let frame: DriverObject = ["x": 0.0, "y": 0.0, "width": 100.0, "height": 100.0]
let windows = NSMutableArray(array: [["windowId": "7", "pid": 42, "processStart": "start", "app": "Fixture", "title": "Untitled", "bounds": frame, "onScreen": true, "layer": 0, "hidden": false]])
let fixture: DriverObject = ["apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "start"]], "windows": windows,
    "trees": ["7": ["AXRole": "AXWindow", "AXTitle": "Untitled", "AXMinimized": false, "AXFullScreen": false, "frame": frame, "children": []]]]
let core = DriverCore(fixture: fixture)
var time = 0.0, activations = 0, active = false, downs = 0, ups = 0, snapshots = 0
var value = config["initial"] as? String ?? "", range = NSRange(location: 0, length: 0)
if let pair = config["selection"] as? [Int] { range = NSRange(location: pair[0], length: pair[1]) }
var events = [DriverObject](), textReads = 0, ownerRestored = false, valueSamples = [Int: Int]()
let focus = DriverFocusBelief(providers: DriverFocusProviders(
    secureInput: { mode == "secure" && ups > 0 }, heldModifiers: { mode == "modifier" && ups > 0 ? 0x100000 : 0 },
    snapshot: { _ in DriverFocusSnapshot(pid: mode == "activation" && ups > 0 && !ownerRestored ? 42 : mode == "front" && ups > 0 ? 9 : 1, processStart: "owner", window: "owner" as CFString) },
    belief: { _, _ in active }, makeEvent: { state in { pid in active = state; if state { activations += 1 }; precondition(pid == 42) } },
    now: { time }, pause: { time += $0 }, restore: { _, _, _ in ownerRestored = true; return true },
    frontmost: { DriverFocusSnapshot(pid: mode == "activation" && !ownerRestored ? 42 : 1, processStart: "owner", window: nil) },
    personInputSince: { _ in mode == "person" && ups > 0 }), trace: { _ in })
let keyboard = DriverKeyboard(layout: { fatalError("Unicode route must not read the keyboard layout") }, makeEvent: { spec in
    return { pid in
        var event = spec.json; event["pid"] = Int(pid); events.append(event)
        if spec.type == "keyDown" {
            downs += 1
            if mode == "uncertain" { throw DriverFault("ACTION_UNCONFIRMED") }
            if mode != "missing" && mode != "delayed" {
                let insert = mode == "limit" ? String((spec.unicode ?? "").prefix(5)) : spec.unicode ?? ""
                let text = value as NSString
                value = text.replacingCharacters(in: range, with: insert)
                range = NSRange(location: range.location + insert.utf16.count, length: 0)
                if mode == "normalized" { value = value.decomposedStringWithCanonicalMapping }
            }
        } else { ups += 1 }
    }
}, pause: { time += 0.004 }, focus: focus,
    textBelief: { config["switch"] as? String ?? "fallback" },
    textSnapshot: { pid, window, _, includeValue in
        precondition(pid == 42 && window == "7"); snapshots += 1
        if mode == "secure-field" && ups > 0 { throw DriverFault("SECURE_FIELD") }
        if mode == "identity" && ups > 0 { throw DriverFault("IDENTITY_CHANGED", "IDENTITY_CHANGED step=keyboard-field-pid") }
        if mode == "unavailable" && ups > 0 { throw DriverFault("AX_UNAVAILABLE") }
        if mode == "delayed" && ups > 0 && time >= 0.03 && value.isEmpty { value = requested; range = NSRange(location: value.utf16.count, length: 0) }
        if includeValue {
            textReads += 1; valueSamples[ups, default: 0] += 1
            // The first sample confirms the delivered chunk. Change only the
            // next sample, immediately before another key-down, with no HID input.
            if ups == (config["afterChunk"] as? Int ?? 1), valueSamples[ups] == 2 {
                if mode == "value-edit" { value += "external" }
                if mode == "caret-edit" { range = NSRange(location: range.location + 1, length: 0) }
            }
        }
        return DriverTextSnapshot(element: (mode == "element" && ups > 0 ? "other" : "field") as CFString,
            window: "bound" as CFString, value: includeValue && mode != "no-readback" ? value : nil,
            selection: includeValue && mode != "no-readback" ? range : nil)
    }, inputMethod: { mode == "ime" }, beforeInput: { _, _ in })
let nonce = String(repeating: "a", count: 64)
func request(_ id: Int, _ method: String, _ params: DriverObject) throws -> DriverRequest {
    try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": id, "method": method,
        "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: id - 1)
}
let binding: DriverObject = ["windowId": "7", "processStart": "start"]
_ = try core.readTree(binding, request: request(1, "getAXState", binding))
var params = binding; params["readId"] = 1; params["args"] = [requested]
// Runtime receipt route
var out: DriverObject
 do { out = ["ok": true, "result": try keyboard.handle(request(2, "typeText", params), core: core)] }
 catch let failure as DriverKeyboardFault { out = ["ok": false, "error": failure.json] }
 catch { out = ["ok": false, "error": ["code": (error as? DriverFault)?.code ?? "unexpected"]] }
out.merge(["events": events, "value": value, "activations": activations, "downs": downs, "ups": ups, "snapshots": snapshots, "textReads": textReads]) { _, new in new }
print(String(data: try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]), encoding: .utf8)!)
`;

// Mutations affect only private staged Swift source. No production file or live
// helper is replaced. Each variant must fail behavioral assertions after compiling.
const mutation = process.env.UC2F_MUTATION;
const variants = {
  input: [
    ['try request.check(); try beforeInput(request, core); try request.check()\n                try identity(); try focus.preflight()',
      'try request.check(); try beforeInput(request, core); try request.check()\n                try identity()'],
    ['if focus.providers.personInputSince(started) { throw DriverFault("PERSON_TOOK_OVER") }', 'if false { throw DriverFault("PERSON_TOOK_OVER") }'],
  ],
  owner: [['if !(try focus.providers.snapshot(request.remaining)).same(owner) {', 'if false {']],
  target: [['CFEqual(element, other.element) && CFEqual(window, other.window)', 'true']],
  secure: [['if role == "AXSecureTextField" || subrole == "AXSecureTextField" { throw DriverFault("SECURE_FIELD") }', 'if false { throw DriverFault("SECURE_FIELD") }']],
  controls: [[String.raw`guard !text.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\t" || $0 == "\r\n" }) else {`, 'guard true else {']],
  flags: [['if !chunk.isEmpty { result += stroke(0, [], unicode: chunk) }\n        return result',
    'if !chunk.isEmpty { result += stroke(0, [], unicode: chunk) }\n        return result.map { DriverKeyboardEvent(type: $0.type, keyCode: $0.keyCode, flags: 0x20000, unicode: $0.unicode) }']],
  pid: [['try posts[index](pid); uncertain = false;', 'try posts[index](pid + 1); uncertain = false;']],
  exact: [['value?.utf16.elementsEqual(expected.0.utf16) == true', 'value == expected.0']],
  resend: [['if let release = release {', 'if sent > 0 || uncertain { try? makeEvent(DriverKeyboardEvent(type: "keyDown", keyCode: 0, flags: 0, unicode: text))(pid) }\n            if let release = release {']],
  count: [['delivered += count; break', 'delivered += chunk.unicodeScalars.count; break']],
  ime: [['bypassed = inputMethod()', 'bypassed = false']],
  restore: [['restoreAfterAction(owner, pid: pid, started: started, attempted: true, budget: request.remaining)', 'restoreAfterAction(owner, pid: pid, started: started, attempted: false, budget: request.remaining)']],
  recheck: [['guard fresh.sameTarget(target), fresh.matches((value, selection)) else {', 'guard fresh.sameTarget(target) else {']],
};
function mutateSource(source) {
  if (!mutation) return source;
  assert.ok(Object.hasOwn(variants, mutation), 'known UC2F mutation');
  const begin = source.indexOf('// Source: DriverKeyboard.swift\n');
  const end = source.indexOf('// Source: ', begin + 4);
  assert.ok(begin >= 0 && end > begin);
  let keyboard = source.slice(begin, end);
  for (const [from, to] of variants[mutation]) {
    assert.equal(keyboard.split(from).length, 2, `${mutation} has exactly one production seam`);
    keyboard = keyboard.replace(from, to);
  }
  return source.slice(0, begin) + keyboard + source.slice(end);
}

async function nativeSource() {
  if (process.env.UC2F_LIGHTWEIGHT !== '1') return macDriverSource();
  const codes = 'let driverErrorCodes: [String: (next: String, unhealthy: Bool)] = [\n' +
    Object.entries(DRIVER_CODES).map(([code, row]) => `"${code}": ("${row.next}", ${row.unhealthy})`).join(',\n') + '\n]\n';
  const names = ['DriverValues.swift', 'DriverFocusBelief.swift', 'DriverKeyboard.swift'];
  const sources = await Promise.all(names.map(async name => `// Source: ${name}\n` +
    await readFile(new URL('../plugins/sleight/lib/mac-driver/native/' + name, import.meta.url), 'utf8')));
  return codes + sources.join('\n') + '\n// Source: TextFixture.swift\n' +
    await readFile(new URL('./fixtures/mac-driver-text-core.swift', import.meta.url), 'utf8') + '\ndriverMain()\n';
}

test('Unicode text delivery with inert OS adapters', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-unicode-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let composed = mutateSource(await nativeSource());
  if (process.env.GLC1_KEYS_MUTANT === 'message') {
    for (const name of ['failure', 'fault', 'coreFailure']) {
      const before = `["KEY_FOCUS_UNAVAILABLE", "IDENTITY_CHANGED"].contains(${name}?.code ?? "")`;
      assert.ok(composed.includes(before), 'keyboard message variant anchor');
      composed = composed.replaceAll(before, `${name}?.code == "KEY_FOCUS_UNAVAILABLE"`);
    }
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  const source = join(root, 'unicode.swift'), binary = join(root, 'unicode');
  const runtimeRoute = mutation || process.env.UC2F_LIGHTWEIGHT === '1' ? '' : String.raw`
if mode.hasPrefix("receipt-") {
    let runtime = DriverRuntime(core: core, nonce: nonce)
    runtime.registerAction(method: "typeText", handler: { request, core in try keyboard.handle(request, core: core) })
    if mode == "receipt-observation-lost" {
        params["read"] = "full"
        runtime.register(method: "settle") { _, _ in throw DriverFault("STALE_ELEMENT") }
    }
    let result = try runtime.handle(request(2, "typeText", params))
    print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!); exit(0)
}
`;
  await writeFile(source, composed.slice(0, at) + '\n' + harness.replace('// Runtime receipt route', runtimeRoute));
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], {
    encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 65536,
  });
  assert.equal(compile.status, 0, compile.stderr); t.diagnostic(`binaryBytes=${(await stat(binary)).size}`);
  const run = (scenario = 'exact', text = payload, extra = {}) => {
    const result = spawnSync(binary, [], { input: JSON.stringify({ case: scenario, text, ...extra }) + '\n',
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  await t.test('native field binding refuses unsafe ancestry before reading values', () => {
    for (const [scenario, code] of [['secure', 'SECURE_FIELD'], ['foreign', 'IDENTITY_CHANGED'],
      ['window', 'KEY_FOCUS_UNAVAILABLE'], ['role', 'KEY_FOCUS_UNAVAILABLE'],
      ['disabled', 'KEY_FOCUS_UNAVAILABLE'], ['cycle', 'KEY_FOCUS_UNAVAILABLE']]) {
      const row = run('adapter-' + scenario);
      assert.equal(row.ok, false); assert.equal(row.error.code, code); assert.equal(row.valueReads, 0);
      assert.ok(row.copies < 210);
    }
    for (const scenario of ['exact', 'no-value', 'size']) {
      const row = run('adapter-' + scenario); assert.equal(row.ok, true);
      assert.equal(row.hasValue, scenario === 'exact'); assert.equal(row.valueReads, scenario === 'size' ? 0 : 1);
    }
  });
  await t.test('2000 ASCII characters and Unicode arrive exactly with no activation or modifier flags', () => {
    for (const text of ['x'.repeat(2000), payload, 'e\u0301'.repeat(40), '']) {
      const row = run('exact', text);
      assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.value, text);
      assert.equal(row.activations, 0); assert.equal(row.result.fakeActiveMs, 0);
      assert.equal(row.result.charactersDelivered, [...text].length);
      assert.equal(row.result.delivery, text ? 'sent-verified' : 'not-sent');
      assert.equal(row.downs, Math.ceil(text.length / 32));
      for (const event of row.events) { assert.equal(event.pid, 42); assert.equal(event.flags, 0); assert.equal(event.keyCode, 0); }
    }
  });
  await t.test('selection replacement uses UTF-16 offsets and exact bytes', () => {
    const row = run('exact', '🙂', { initial: 'a日本z', selection: [1, 2] });
    assert.equal(row.ok, true); assert.equal(row.value, 'a🙂z'); assert.equal(row.result.charactersDelivered, 1);
  });
  if (!mutation && process.env.UC2F_LIGHTWEIGHT !== '1') {
    for (const scenario of ['receipt-none', 'receipt-observation-lost']) {
      await t.test(`${scenario} preserves Unicode receipt metadata through the real runtime`, () => {
        const row = run(scenario);
        assert.equal(row.charactersDelivered, 9); assert.equal(row.charactersPosted, 9);
        assert.equal(row.compositionBypassed, false); assert.equal(row.textBeliefFallback, false);
        assert.equal(row.delivery, scenario === 'receipt-none' ? 'sent-verified' : 'sent-unverified');
        if (scenario === 'receipt-observation-lost') assert.equal(row.observationError, 'STALE_ELEMENT');
      });
    }
  }
  for (const scenario of ['value-edit', 'caret-edit']) for (const afterChunk of [0, 1, 2]) {
    await t.test(`${scenario} before key-down ${afterChunk + 1} stops without a HID signal`, () => {
      const row = run(scenario, 'x'.repeat(96), { afterChunk, initial: 'initial' });
      assert.equal(row.downs, afterChunk); assert.equal(row.ups, afterChunk); assert.equal(row.activations, 0);
      assert.equal(row.ok, false, JSON.stringify(row)); assert.equal(row.error.code, 'PERSON_TOOK_OVER');
      assert.equal(row.error.focusChanged, true); assert.equal(row.error.charactersDelivered, afterChunk * 32);
    });
  }
  await t.test('Return and Tab refuse before preparing or posting text', () => {
    for (const text of ['a\nb', 'a\rb', 'a\tb']) {
      const row = run('exact', text); assert.equal(row.ok, false); assert.equal(row.error.code, 'ACTION_UNSUPPORTED'); assert.equal(row.events.length, 0);
    }
  });
  for (const [scenario, code, changed] of [['secure', 'SECURE_INPUT_ACTIVE'], ['secure-field', 'SECURE_FIELD'],
    ['modifier', 'PERSON_HOLDS_MODIFIER'], ['person', 'PERSON_TOOK_OVER'], ['front', 'PERSON_TOOK_OVER', true],
    ['element', 'PERSON_TOOK_OVER', true], ['identity', 'IDENTITY_CHANGED']]) {
    await t.test(`${scenario} between chunks stops before a second key-down`, () => {
      const row = run(scenario, 'x'.repeat(64));
      assert.equal(row.ok, false); assert.equal(row.error.code, code, JSON.stringify(row));
      if (scenario === 'identity') assert.equal(row.error.message, 'IDENTITY_CHANGED step=keyboard-field-pid');
      assert.equal(row.downs, 1); assert.equal(row.ups, 1); assert.equal(row.activations, 0);
      if (changed) assert.equal(row.error.focusChanged, true);
    });
  }
  for (const scenario of ['missing', 'uncertain', 'unavailable', 'normalized']) {
    await t.test(`${scenario} delivery is never resent under belief`, () => {
      const row = run(scenario);
      assert.equal(row.ok, false); assert.equal(row.error.retry, 'read-first');
      assert.equal(row.downs, 1); assert.equal(row.ups, 1); assert.equal(row.activations, 0);
      assert.equal(row.error.charactersDelivered, 0);
    });
  }
  await t.test('delayed delivery is polled without reposting', () => {
    const row = run('delayed'); assert.equal(row.ok, true); assert.equal(row.value, payload);
    assert.equal(row.downs, 1); assert.equal(row.activations, 0);
  });
  await t.test('a length limit reports the verified prefix and aborts without resend', () => {
    const row = run('limit', 'abcdefghij');
    assert.equal(row.ok, false); assert.equal(row.error.code, 'ACTION_UNCONFIRMED');
    assert.equal(row.error.charactersDelivered, 5); assert.equal(row.value, 'abcde'); assert.equal(row.downs, 1);
  });
  await t.test('an accidental activation restores only the recorded owner and aborts', () => {
    const row = run('activation', 'x'.repeat(64));
    assert.equal(row.ok, false); assert.equal(row.error.focusChanged, true); assert.equal(row.error.focusRestored, true);
    assert.equal(row.downs, 1); assert.equal(row.activations, 0);
  });
  await t.test('IME bypass is reported with exact Unicode readback', () => {
    const row = run('ime'); assert.equal(row.ok, true); assert.equal(row.value, payload);
    assert.equal(row.result.compositionBypassed, true); assert.equal(row.activations, 0);
  });
  await t.test('missing readback chooses belief before the first text post', () => {
    const row = run('no-readback'); assert.equal(row.ok, true);
    assert.equal(row.activations, 1); assert.equal(row.result.textBeliefFallback, true);
    assert.equal(row.result.delivery, 'sent-unverified'); assert.equal(row.downs, 1);
  });
});
