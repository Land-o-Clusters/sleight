import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { STRICT_TEXT_CONTROL_REFUSAL } from '../plugins/sleight/lib/mac-driver/preserve.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

test('conditional control-character refusal has a separate notice pin', async () => {
  const source = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverStrictText.swift', import.meta.url), 'utf8');
  const notice = /static let controlRefusal = "([^"]+)"/.exec(source)[1];
  assert.equal(notice, STRICT_TEXT_CONTROL_REFUSAL);
  const baseline = JSON.parse(await readFile(new URL('./fixtures/prompt-default.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(notice).digest('hex'), baseline.strictTextControlNotice);
  assert.ok(Buffer.byteLength(notice) <= 200);
});

// Only injected AX, clipboard and input providers run. No native registrar or desktop entry point runs.
const entry = String.raw`
let config = try! DriverJSON.decode(Data(readLine()!.utf8))
let fixture = config["fixture"] as! DriverObject
let core = DriverCore(fixture: fixture)
var nodes = [String: DriverNode](), records = [String: DriverObject](), parents = [String: DriverNode]()
func collect(_ node: DriverNode, _ parent: DriverNode? = nil) {
    nodes[node.path] = node; records[node.path] = node.fake!
    if let parent = parent { parents[node.path] = parent }
    for (i, raw) in (node.fake!["children"] as? [DriverObject] ?? []).enumerated() {
        collect(DriverNode(fake: raw, path: node.path + "/\(i)"), node)
    }
}
collect(DriverNode(fake: (fixture["trees"] as! DriverObject)["7"] as! DriverObject, path: "7"))
var pauses = 0
var qualificationTexts = [String]()
var vanished = false
var mutations = [String](), valueReads = 0, guards = 0, clipboardWrites = 0, reservations = 0, settableCalls = 0
var siblingRoleReads = 0
var boardCount = 11, boardItems: [[String: Data]] = [["public.utf8-plain-text": Data("owner".utf8)], ["public.rtf": Data([0,1,255])]]
if let supplied = config["boardItems"] as? [[String: String]] {
    boardItems = supplied.map { $0.mapValues { Data(base64Encoded: $0)! } }
}
let originalBoardItems = boardItems
var boardReleased = false
var boundaryCounts = [String: Int]()
var externalTransitions = 0, lastExternalCount = boardCount
var lastExternalItems = boardItems
func boundary(_ kind: String) throws {
    boundaryCounts[kind, default: 0] += 1
    let label = "\(kind):\(boundaryCounts[kind]!)"
    if config["externalAt"] as? String == label {
        boardCount += 1; boardItems = [["external-version": Data((config["externalBytes"] as? String ?? "U").utf8)]]
        externalTransitions += 1; lastExternalCount = boardCount; lastExternalItems = boardItems
    }
    if config["countOnlyAt"] as? String == label {
        boardCount += 17; externalTransitions += 1; lastExternalCount = boardCount; lastExternalItems = boardItems
    }
    if config["cancelAt"] as? String == label { throw DriverFault("PERSON_TOOK_OVER") }
}
let access = DriverSemanticAccess(attributes: { node, names, request in
    try boundary("attributes")
    if names.contains("AXRole"), node.path.hasPrefix("7/1/"), node.path != "7/1/0" { siblingRoleReads += 1 }
    if config["siblingRoleChanged"] as? Bool == true, node.path == "7/1/1", names.contains("AXRole") { return ["AXRole": "AXStaticText"] }
    if vanished { throw DriverFault("STALE_ELEMENT") }
    if names.contains("AXValue") {
        valueReads += 1
        if records[node.path]?["AXSubrole"] as? String == "AXSecureTextField" { fatalError("secure value read") }
        if let count = config["readbackSize"] as? Int { return ["AXValue": String(repeating: config["readbackCharacter"] as? String ?? "a", count: count)] }
    }
    if names.contains("AXNumberOfCharacters"), let count = config["characterCount"] as? Int { return ["AXNumberOfCharacters": count] }
    if names.contains("AXNumberOfCharacters"), !mutations.isEmpty, config["oversizeAfterWrite"] as? Bool == true { return ["AXNumberOfCharacters": 1_048_577] }
    return (records[node.path] ?? [:]).filter { names.contains($0.key) }
}, isSettable: { node, name, _ in
    try boundary("settable")
    settableCalls += 1
    if config["secureOnSettable"] as? Int == settableCalls { records[node.path]?["AXSubrole"] = "AXSecureTextField" }
    return (records[node.path]?[name == "AXSelectedTextRange" ? "rangeSettable" : name == "AXSelectedText" ? "selectedTextSettable" : "settable"] as? Bool) ?? false
}, set: { node, name, value, _ in
    try boundary("set")
    mutations.append(name)
    if config["vanishAfterWrite"] as? Bool == true { vanished = true }
    if config["setFails"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
    if config["ignoreWrite"] as? Bool != true {
        if name == "AXSelectedText" {
            let before = records[node.path]!["AXValue"] as! String
            let range = records[node.path]!["AXSelectedTextRange"] as! [Int]
            let inserted = value as! String
            records[node.path]?["AXValue"] = (before as NSString).replacingCharacters(in: NSRange(location: range[0], length: range[1]), with: inserted)
            records[node.path]?["AXSelectedTextRange"] = [range[0] + inserted.utf16.count, 0]
        } else { records[node.path]?[name] = value }
        if config["numericBoolean"] as? Bool == true, let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() {
            records[node.path]?[name] = number.boolValue ? 1 : 0
        }
    }
    if config["secureAfterWrite"] as? Bool == true { records[node.path]?["AXSubrole"] = "AXSecureTextField" }
}, actionNames: { node, _ in
    if config["actionsFail"] as? Bool == true { throw DriverFault("AX_UNAVAILABLE") }
    return records[node.path]?["actions"] as? [String] ?? []
},
secondaryActions: { node, request in
    if config["actionChanged"] as? Bool == true { return [("Show menu", "AXDifferent")] }
    return try node.secondaryActions(request)
}, perform: { node, name, _ in
    mutations.append(name)
    if config["vanishAfterWrite"] as? Bool == true { vanished = true }
    if config["setFails"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
}, parent: { node, _ in parents[node.path] }, children: { node, _ in
    if config["childrenFail"] as? Bool == true { throw DriverFault("AX_UNAVAILABLE") }
    if config["largeGroup"] as? Bool == true { throw DriverFault("ACTION_UNSUPPORTED") }
    return nodes.values.filter { parents[$0.path]?.same(node) == true }.sorted { $0.path < $1.path }
}, focused: { _, _ in
    let path = config["focusPath"] as? String ?? "7/0/0"
    return nodes[path]
})
let semantic = DriverSemantic(access: access, qualification: { _, _, path, text in
    qualificationTexts.append(text)
    return config["unqualified"] as? Bool != true && !(config["singleLineOnly"] as? Bool == true && DriverStrictText.hasTextControls(text))
},
    beforeInput: { request, _ in
    try boundary("guard")
    guards += 1
    if config["deadlineAfterPaste"] as? Bool == true && mutations.contains("paste") { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) }
    if let n = config["guardFailsAt"] as? Int, guards == n { throw DriverFault("PERSON_TOOK_OVER") }
    if let n = config["secureOnGuard"] as? Int, guards == n { records["7/0/0"]?["AXSubrole"] = "AXSecureTextField" }
    if let n = config["changeValueOnGuard"] as? Int, guards == n { records["7/0/0"]?["AXValue"] = config["changedValue"] }
}, sendUnicode: { request, _, pid, text in
    try boundary("unicode")
    precondition(pid == 42)
    mutations.append("paste")
    if config["pasteNotSent"] as? Bool == true {
        var fault = DriverFault("KEY_FOCUS_UNAVAILABLE")
        fault.disposition = ["delivery": "not-sent", "retry": "safe"]
        throw fault
    }
    if config["clipboardConflict"] as? Bool == true { boardCount += 1; boardItems = [["owner-new": Data([9])]] }
    if config["pasteThrows"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
    if config["pasteUnconfirmed"] as? Bool != true {
        let before = records["7/0/0"]!["AXValue"] as! String
        let range = records["7/0/0"]!["AXSelectedTextRange"] as! [Int]

        records["7/0/0"]?["AXValue"] = (before as NSString).replacingCharacters(in: NSRange(location: range[0], length: range[1]), with: text)
        records["7/0/0"]?["AXSelectedTextRange"] = [range[0] + text.utf16.count, 0]
    }
}, pause: { _ in
    pauses += 1
    if config["settleAtPause"] as? Int == pauses {
        let before = records["7/0/0"]!["AXValue"] as! String
        let range = records["7/0/0"]!["AXSelectedTextRange"] as! [Int]
        let text = (config["args"] as! [Any])[0] as! String
        records["7/0/0"]?["AXValue"] = (before as NSString).replacingCharacters(in: NSRange(location: range[0], length: range[1]), with: text)
        records["7/0/0"]?["AXSelectedTextRange"] = [range[0] + text.utf16.count, 0]
    }
})
let nonce = String(repeating: "a", count: 64)
func request(_ id: Int, _ method: String, _ params: DriverObject) throws -> DriverRequest {
    try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": id,
        "method": method, "params": params, "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: 0)
}
let binding: DriverObject = ["windowId": "7", "processStart": "start"]
let read = try! core.readTree(binding, request: request(1, "getAXState", binding))
var params = binding; params["readId"] = read["readId"]; params["args"] = config["args"]!
for (key, value) in config["params"] as? DriverObject ?? [:] { params[key] = value }
let method = config["method"] as! String
let req = try! request(2, method, params)
// Exercise systemUnicode directly, independently of postUnicode's early guard.
if let chunks = config["directUnicodeChunks"] as? [String] {
    var events = 0, prepared = 0, code: String?
    do {
        let posts = try DriverStrictText.systemUnicode(chunks, sink: { _, _ in events += 1 })
        prepared = posts.count
        for post in posts { post(42) }
    } catch let fault as DriverFault { code = fault.code } catch { code = "UNEXPECTED" }
    let out: DriverObject = ["events": events, "prepared": prepared, "code": code as Any? ?? NSNull()]
    print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!); exit(0)
}
if let planText = config["unicodePlan"] as? String {
    var chunks = [String](), posts = [Int32](), events = [DriverObject](), checkpoints = 0, code: String?
    do {
        try DriverStrictText.postUnicode(req, pid: 42, text: planText, prepare: { supplied in
            chunks = supplied
            if config["prepareFails"] as? Bool == true { throw DriverFault("ACTION_UNCONFIRMED") }
            if config["systemEvents"] as? Bool == true {
                return try DriverStrictText.systemUnicode(supplied, sink: { event, pid in
                    var length = 0, units = [UniChar](repeating: 0, count: 32)
                    event.keyboardGetUnicodeString(maxStringLength: 32, actualStringLength: &length, unicodeString: &units)
                    events.append(["type": event.type.rawValue, "pid": pid, "flags": event.flags.rawValue,
                        "keyCode": event.getIntegerValueField(.keyboardEventKeycode),
                        "autorepeat": event.getIntegerValueField(.keyboardEventAutorepeat),
                        "units": Array(units.prefix(length))])
                })
            }
            return supplied.map { _ in { pid in posts.append(pid) } }
        }, checkpoint: {
            checkpoints += 1
            if config["cancelAtPair"] as? Int == checkpoints { throw DriverFault("PERSON_TOOK_OVER") }
        })
    } catch let fault as DriverFault { code = fault.code } catch { code = "UNEXPECTED" }
    let out: DriverObject = ["chunks": chunks, "pids": posts, "events": events, "checkpoints": checkpoints, "code": code as Any? ?? NSNull()]
    print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!); exit(0)
}
var out: DriverObject
// Semantic test registration is local to this fixture process.
do {
    let result: DriverObject?
    if method == "click" || method == "doubleClick" || method == "rightClick" { result = try semantic.trySiblingPress(req, core: core) }
    else { result = try semantic.handle(req, core: core) }
    out = ["ok": true, "result": result as Any? ?? NSNull()]
} catch let fault as DriverFault {
    out = ["ok": false, "error": fault.json]
} catch { out = ["ok": false, "error": ["code": "UNEXPECTED"]] }
if config["shutdown"] as? Bool == true { semantic.shutdown() }
out["qualificationTexts"] = qualificationTexts
out["pauses"] = pauses
out["mutations"] = mutations; out["valueReads"] = valueReads; out["guards"] = guards
out["siblingRoleReads"] = siblingRoleReads
out["admitted"] = req.inputAdmitted; out["clipboardWrites"] = clipboardWrites
out["clipboardRestored"] = boardItems == originalBoardItems
out["clipboardNewOwner"] = boardItems == [["owner-new": Data([9])]]
out["boundaryCounts"] = boundaryCounts
out["externalTransitions"] = externalTransitions
out["externalVersionsOverwritten"] = boardCount == lastExternalCount && boardItems == lastExternalItems ? 0 : 1
out["inputSends"] = mutations.count
out["released"] = boardReleased; out["reservations"] = reservations
if records["7/0/0"]?["AXSubrole"] as? String != "AXSecureTextField" { out["range"] = records["7/0/0"]?["AXSelectedTextRange"] }
print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
`;
const frame = { x: 0, y: 0, width: 100, height: 100 };
const node = (AXRole, rest = {}) => ({ AXRole, frame, ...rest });
const makeFixture = () => ({
  apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: 'start' }],
  windows: [{ windowId: '7', pid: 42, processStart: 'start', app: 'Fixture', title: 'Fixture', bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: node('AXWindow', { AXTitle: 'Fixture', AXMinimized: false, AXFullScreen: false, children: [
    node('AXGroup', { children: [node('AXTextField', { AXValue: 'abc old xyz', AXFocused: true, AXEnabled: true, AXSelectedTextRange: [4, 3], settable: true, rangeSettable: true, selectedTextSettable: true }),
      node('AXSecureTextField', { forbidReads: ['AXValue'], settable: true })] }),
    node('AXGroup', { children: [node('AXButton', { AXTitle: 'One', AXEnabled: true, actions: ['AXPress', 'AXShowMenu'], actionDescriptions: { AXShowMenu: 'Show menu' } }),
      node('AXButton', { AXTitle: 'Two', actions: ['AXPress'] })] }),
  ] }) },
});

test('semantic actions use retained bindings and injected providers only', { skip: process.platform !== 'darwin', timeout: 600000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-semantic-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'semantic.swift'), binary = join(root, 'semantic');
  let composed = macDriverSource();
  if (process.env.GLS4_SEMANTIC_MUTANT) {
    const begin = composed.indexOf('    func trySiblingPress('), end = composed.indexOf('    private static func buttonOrTab', begin);
    let body = composed.slice(begin, end);
    const variants = {
      witness: ['Self.buttonOrTab(try access.attributes(witness, [kAXRoleAttribute, kAXSubroleAttribute], request))', 'true'],
      final: ['try beforeInput(request, core); try request.check()', 'try request.check()'],
      after: ['try afterDelivery(request, core: core, target: args[0], window: bound.window) { _ in result(bound.window, verified: false) }', 'result(bound.window, verified: false)'],
    };
    const [before, after] = variants[process.env.GLS4_SEMANTIC_MUTANT];
    assert.ok(body.includes(before), 'sibling mutation anchor'); body = body.replace(before, after);
    composed = composed.slice(0, begin) + body + composed.slice(end);
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  await writeFile(source, composed.slice(0, at) + '\n' + entry);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 480000, maxBuffer: 65536 });
  assert.equal(compile.status, 0, JSON.stringify({ stderr: compile.stderr, signal: compile.signal, error: compile.error?.code, pid: compile.pid }));
  t.diagnostic(`semanticBinaryBytes=${(await stat(binary)).size}`);
  const run = (method, args, options = {}, change = () => {}) => {
    const fixture = makeFixture(); change(fixture);
    const result = spawnSync(binary, [], { input: JSON.stringify({ fixture, method, args, ...options }) + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  const failure = (row, code, attempted = false) => {
    assert.equal(row.ok, false, JSON.stringify(row)); assert.equal(row.error.code, code, JSON.stringify(row));
    assert.equal(row.admitted, attempted);
    assert.equal(row.error.delivery, attempted ? 'unknown' : 'not-sent');
    assert.equal(row.error.retry, attempted ? 'read-first' : 'safe');
  };
  await t.test('setValue verifies string, numeric and boolean values without returning them', () => {
    for (const value of ['replacement', 4.5, true]) {
      const row = run('setValue', [2, value]);
      assert.equal(row.ok, true); assert.equal(row.result.delivery, 'sent-verified');
      assert.deepEqual(row.mutations, ['AXValue']); assert.equal(row.result.valueVerified, true);
      assert.equal(Object.hasOwn(row.result, 'value'), false); assert.equal(row.admitted, true);
    }
  });
  await t.test('setValue cannot claim success for a refused or ignored AX write', () => {
    failure(run('setValue', [2, 'v'], { ignoreWrite: true }), 'ACTION_UNCONFIRMED', true);
    failure(run('setValue', [2, 'v'], { setFails: true }), 'ACTION_UNCONFIRMED', true);
    const row = run('setValue', [2, 'v'], {}, f => { f.trees[7].children[0].children[0].settable = false; });
    failure(row, 'VALUE_NOT_SETTABLE'); assert.deepEqual(row.mutations, []);
  });
  await t.test('setValue readback stops at 1 MiB and keeps an oversized delivered write unverified', () => {
    const limit = 1_048_576;
    for (const options of [{ readbackSize: limit + 1 }, { readbackSize: limit / 2 + 1, readbackCharacter: 'é' }]) {
      const row = run('setValue', [2, 'v'], options);
      assert.equal(row.ok, true); assert.equal(row.result.delivery, 'sent-unverified');
      assert.equal(row.result.valueVerified, false); assert.equal(row.result.valueReadback, 'over-limit');
      assert.equal(row.result.valueReadbackLimit, limit); assert.equal(row.valueReads, 1);
      assert.deepEqual(row.mutations, ['AXValue']); assert.equal(Object.hasOwn(row.result, 'value'), false);
    }
    const known = run('setValue', [2, 'v'], { characterCount: limit + 1 });
    assert.equal(known.ok, true); assert.equal(known.result.valueReadback, 'over-limit'); assert.equal(known.valueReads, 0);
    const exact = run('setValue', [2, 'a'.repeat(limit)]);
    assert.equal(exact.ok, true); assert.equal(exact.result.valueVerified, true);
  });
  await t.test('selection and paste reject values above 1 MiB of UTF-8 before any write', () => {
    for (const [method, args] of [['selectText', [2, 'é']], ['paste', ['new']]]) {
      const row = run(method, args, { readbackSize: 524289, readbackCharacter: 'é' });
      failure(row, 'ACTION_UNSUPPORTED'); assert.deepEqual(row.mutations, []); assert.equal(row.clipboardWrites, 0);
    }
  });
  await t.test('boolean readback accepts AX numeric zero/one and exact text cannot normalize away a change', () => {
    assert.equal(run('setValue', [2, true], { numericBoolean: true }).result.delivery, 'sent-verified');
    assert.equal(run('setValue', [2, false], { numericBoolean: true }).result.delivery, 'sent-verified');
    const changed = run('selectText', [2, 'cat'], { changeValueOnGuard: 2, changedValue: 'e\u0301 cat' },
      f => { f.trees[7].children[0].children[0].AXValue = '\u00e9 cat'; });
    failure(changed, 'STALE_ELEMENT'); assert.deepEqual(changed.mutations, []);
  });
  await t.test('secure fields, changed subroles and secure descendants never read a value', () => {
    const cases = [run('setValue', [3, 'v']), run('selectText', [3, 'secret']),
      run('setValue', [2, 'v'], { secureOnGuard: 1 }),
      run('setValue', [2, 'v'], { secureOnGuard: 3 }),
      run('setValue', [2, 'v'], { secureOnSettable: 2 }),
      run('setValue', [2, 'v'], {}, f => { f.trees[7].children[0].AXSubrole = 'AXSecureTextField'; })];
    for (const row of cases) { failure(row, 'SECURE_FIELD'); assert.equal(row.valueReads, 0); assert.deepEqual(row.mutations, []); }
    const after = run('setValue', [2, 'v'], { secureAfterWrite: true });
    failure(after, 'SECURE_FIELD', true); assert.equal(after.valueReads, 0);
  });
  await t.test('binding, stale read, disabled and lease/person refusals precede all writes', () => {
    failure(run('setValue', [2, 'v'], { params: { readId: 8 } }), 'STALE_READ');
    failure(run('setValue', [2, 'v'], { params: { processStart: 'recycled' } }), 'IDENTITY_CHANGED');
    failure(run('setValue', [2, 'v'], { guardFailsAt: 1 }), 'PERSON_TOOK_OVER');
    failure(run('setValue', [2, 'v'], {}, f => { f.trees[7].children[0].children[0].AXEnabled = false; }), 'ELEMENT_DISABLED');
  });
  await t.test('selection finds exact text and verifies UTF-16 selected ranges', () => {
    for (const [selectionType, expected] of [['text', [3, 3]], ['cursor_before', [3, 0]], ['cursor_after', [6, 0]]]) {
      const row = run('selectText', [2, 'cat', { selectionType }], {}, f => { f.trees[7].children[0].children[0].AXValue = '🙂 cat dog'; });
      assert.equal(row.ok, true); assert.deepEqual(row.range, expected); assert.deepEqual(row.result.selectedRange, expected);
      assert.equal(row.result.matchCount, 1);
      assert.deepEqual(row.mutations, ['AXSelectedTextRange']); assert.equal(row.result.delivery, 'sent-verified');
    }
  });
  await t.test('duplicate and overlapping matches require exact adjacent prefix/suffix', () => {
    const change = f => { f.trees[7].children[0].children[0].AXValue = 'one cat two cat'; };
    const ambiguous = run('selectText', [2, 'cat'], {}, change);
    failure(ambiguous, 'AMBIGUOUS_ELEMENT'); assert.equal(ambiguous.error.matchCount, 2);
    const selected = run('selectText', [2, 'cat', { prefix: 'two ', suffix: '' }], {}, change);
    assert.equal(selected.ok, true); assert.deepEqual(selected.range, [12, 3]);
    failure(run('selectText', [2, 'CAT'], {}, change), 'STALE_ELEMENT');
    failure(run('selectText', [2, 'aa'], {}, f => { f.trees[7].children[0].children[0].AXValue = 'aaa'; }), 'AMBIGUOUS_ELEMENT');
    failure(run('selectText', [2, 'cat'], { ignoreWrite: true }, change), 'AMBIGUOUS_ELEMENT');
    failure(run('selectText', [2, 'old', { selectionType: 'cursor_after' }], { ignoreWrite: true }), 'ACTION_UNCONFIRMED', true);
    const literal = run('selectText', [2, 'cat', { prefix: 'a\u0327\u0301 ' }], {},
      f => { f.trees[7].children[0].children[0].AXValue = 'a\u0301\u0327 cat a\u0327\u0301 cat'; });
    assert.equal(literal.ok, true); assert.deepEqual(literal.range, [12, 3]);
  });
  await t.test('secondary actions must still match the retained printed action name', () => {
    const row = run('performSecondaryAction', [5, 'Show menu']);
    assert.equal(row.ok, true); assert.deepEqual(row.mutations, ['AXShowMenu']); assert.equal(row.result.delivery, 'sent-unverified');
    failure(run('performSecondaryAction', [5, 'AXShowMenu']), 'ACTION_UNSUPPORTED');
    failure(run('performSecondaryAction', [5, 'Show menu'], { actionChanged: true }), 'ACTION_UNSUPPORTED');
    failure(run('performSecondaryAction', [5, 'Press']), 'ACTION_UNSUPPORTED');
    failure(run('performSecondaryAction', [3, 'Show menu']), 'SECURE_FIELD');
  });
  await t.test('only a plain left single click on sibling buttons or tabs can use AXPress', () => {
    const row = run('click', [5]); assert.equal(row.ok, true); assert.deepEqual(row.mutations, ['AXPress']);
    assert.equal(row.result.delivery, 'sent-unverified'); assert.equal(row.result.semanticPress, true);
    for (const [method, args] of [['doubleClick', [5]], ['rightClick', [5]], ['click', [5, { clickCount: 2 }]],
      ['click', [5, { mouseButton: 'right' }]], ['click', [[1, 2]]], ['click', [3]]]) {
      const skipped = run(method, args); assert.equal(skipped.result, null); assert.deepEqual(skipped.mutations, []);
    }
    const tab = run('click', [5], {}, f => { for (const n of f.trees[7].children[1].children) n.AXSubrole = 'AXTabButton'; });
    assert.deepEqual(tab.mutations, ['AXPress']);
    const lone = run('click', [5], {}, f => { f.trees[7].children[1].children.pop(); });
    assert.equal(lone.result, null); assert.deepEqual(lone.mutations, []);
    const large = run('click', [5], {}, f => {
      f.trees[7].children[1].children.push(...Array.from({ length: 255 }, () => node('AXButton', { actions: ['AXPress'] })));
    });
    assert.equal(large.result, null); assert.deepEqual(large.mutations, []);
    const foreign = run('click', [5], {}, f => { f.trees[7].children[1].children[1].pid = 99; });
    assert.equal(foreign.result, null); assert.deepEqual(foreign.mutations, []);
    assert.equal(run('click', [5], { guardFailsAt: 1 }).result, null);
  });
  await t.test('sibling press uses one live witness and three input guards for a 50-button group', () => {
    const row = run('click', [5], {}, f => {
      f.trees[7].children[1].children.push(...Array.from({ length: 48 }, () => node('AXButton', { actions: ['AXPress'] })));
    });
    assert.deepEqual(row.mutations, ['AXPress']);
    const changed = run('click', [5], { siblingRoleChanged: true });
    assert.equal(changed.result, null); assert.deepEqual(changed.mutations, []);
    const stopped = run('click', [5], { guardFailsAt: 2 });
    assert.equal(stopped.result, null); assert.deepEqual(stopped.mutations, []);
    failure(run('click', [5], { guardFailsAt: 3 }), 'PERSON_TOOK_OVER', true);
    assert.equal(row.guards, 3, 'checked before/after plus the final input fence');
    assert.equal(row.siblingRoleReads, 1, 'only the retained witness needs a live role query');
  });
  await t.test('delivered semantic writes return sent-unverified when their target closes', () => {
    for (const [method, args] of [['setValue', [2, 'v']], ['performSecondaryAction', [5, 'Show menu']], ['click', [5]], ['paste', ['new']]]) {
      const row = run(method, args, { vanishAfterWrite: true });
      assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.result.delivery, 'sent-unverified');
      assert.equal(row.mutations.length, 1);
    }
  });
  await t.test('pre-press AX errors and ineligible groups leave pointer dispatch available', () => {
    for (const option of ['actionsFail', 'childrenFail', 'largeGroup']) {
      const row = run('click', [5], { [option]: true });
      assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.result, null); assert.deepEqual(row.mutations, []);
    }
    for (const change of [f => { f.trees[7].children[1].AXRole = 'AXList'; },
      f => { f.trees[7].children[1].children[0].AXEnabled = false; },
      f => { f.trees[7].children[1].children[0].actions = []; }]) {
      const row = run('click', [5], {}, change); assert.equal(row.result, null); assert.deepEqual(row.mutations, []);
    }
    failure(run('click', [5], { setFails: true }), 'ACTION_UNCONFIRMED', true);
  });
  await t.test('strict selected-text insertion sends once without any clipboard access', () => {
    const row = run('paste', ['new']);
    assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.result.delivery, 'sent-verified');
    assert.equal(row.result.clipboard, 'untouched'); assert.equal(row.result.textPath, 'ax-selected-text');
    assert.equal(row.result.semantics, 'replace-selection-plain-text');
    assert.deepEqual(row.range, [7, 0]); assert.deepEqual(row.mutations, ['AXSelectedText']);
    assert.equal(row.clipboardWrites, 0); assert.equal(row.reservations, 0);
    assert.equal(Object.hasOwn(row.result, 'text'), false);
  });
  await t.test('Unicode event preparation preserves scalars and every post uses the leased pid', () => {
    for (const [text, lengths] of [['😀'.repeat(17), [32, 2]], ['e' + '\u0301'.repeat(69), [32, 32, 6]], ['AB', [2]]]) {
      const row = run('paste', ['unused'], { unicodePlan: text });
      assert.equal(row.chunks.join(''), text); assert.deepEqual(row.chunks.map(chunk => chunk.length), lengths);
      assert.ok(row.chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
      assert.deepEqual(row.pids, lengths.map(() => 42)); assert.equal(row.code, null);
    }
    const failed = run('paste', ['unused'], { unicodePlan: 'x'.repeat(70), prepareFails: true });
    assert.deepEqual(failed.pids, []); assert.equal(failed.code, 'ACTION_UNCONFIRMED');
    const stopped = run('paste', ['unused'], { unicodePlan: 'x'.repeat(70), cancelAtPair: 2 });
    assert.deepEqual(stopped.pids, [42]); assert.equal(stopped.code, 'PERSON_TOOK_OVER');
  });
  await t.test('systemUnicode constructs real events into a recording sink, with scalar-safe chunks and paired edges', () => {
    const text = 'x'.repeat(31) + '😀' + 'e\u0301' + '🙂'.repeat(34);
    const row = run('paste', ['unused'], { unicodePlan: text, systemEvents: true });
    assert.equal(row.code, null); assert.equal(row.events.length, row.chunks.length * 2);
    assert.equal(row.chunks.join(''), text); assert.ok(row.chunks.every(chunk => chunk.length <= 32 && chunk.isWellFormed()));
    for (let i = 0; i < row.chunks.length; i++) {
      const [down, up] = row.events.slice(i * 2, i * 2 + 2);
      const units = Array.from({ length: row.chunks[i].length }, (_, n) => row.chunks[i].charCodeAt(n));
      assert.deepEqual(down, { type: 10, pid: 42, flags: 0, keyCode: 0, autorepeat: 0, units });
      assert.deepEqual(up, { ...down, type: 11 });
    }
    const stopped = run('paste', ['unused'], { unicodePlan: text, systemEvents: true, cancelAtPair: 2 });
    assert.equal(stopped.events.length, 2); assert.equal(stopped.code, 'PERSON_TOOK_OVER');
    for (const control of ['\n', '\r\n', '\t', 'trailing\n', '\u0085', '\u2028', '\u2029']) {
      const refused = run('paste', ['unused'], { unicodePlan: control, systemEvents: true });
      assert.equal(refused.code, 'ACTION_UNSUPPORTED'); assert.deepEqual(refused.events, []);
    }
  });
  await t.test('systemUnicode directly refuses invalid chunks before constructing a sendable pair', () => {
    const invalid = ['', 'x'.repeat(33), '😀'.repeat(17), '\n', '\r', '\r\n', '\t', 'trailing\n', '\u0085', '\u2028', '\u2029'];
    for (const chunk of invalid) {
      for (const chunks of [[chunk], ['valid', chunk]]) {
        const row = run('paste', ['unused'], { directUnicodeChunks: chunks });
        assert.deepEqual(row, { code: 'ACTION_UNSUPPORTED', prepared: 0, events: 0 }, JSON.stringify(chunks));
      }
    }
    const valid = run('paste', ['unused'], { directUnicodeChunks: ['x'.repeat(32), '😀'.repeat(16), 'e\u0301'] });
    assert.deepEqual(valid, { code: null, prepared: 3, events: 6 });
  });
  await t.test('strict Unicode route posts explicit text once to the leased pid', () => {
    for (const text of ['A😀e\u0301', 'plain text']) {
      const row = run('paste', [text], {}, f => { f.trees[7].children[0].children[0].selectedTextSettable = false; });
      assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.result.delivery, 'sent-verified');
      assert.equal(row.result.textPath, 'unicode-pid'); assert.equal(row.result.clipboard, 'untouched');
      assert.deepEqual(row.mutations, ['paste']); assert.equal(row.clipboardWrites, 0);
    }
  });
  await t.test('LF, CRLF, Tab and trailing newline insert as selected text or refuse with zero Unicode events', () => {
    for (const text of ['\n', '\r\n', '\t', 'trailing\n', 'form\nsubmit']) {
      const inserted = run('paste', [text]);
      assert.equal(inserted.ok, true, JSON.stringify(inserted));
      assert.deepEqual(inserted.mutations, ['AXSelectedText']);
      assert.ok(inserted.qualificationTexts.every(value => value === text));
      const refused = run('paste', [text], {}, f => { f.trees[7].children[0].children[0].selectedTextSettable = false; });
      failure(refused, 'ACTION_UNSUPPORTED'); assert.deepEqual(refused.mutations, []);
      assert.match(refused.error.message, /Line breaks and tabs/);
      const form = run('paste', [text], { singleLineOnly: true });
      failure(form, 'ACTION_UNSUPPORTED'); assert.deepEqual(form.mutations, []);
    }
  });
  await t.test('selection insertion never splits a surrogate pair or normalizes combining text', () => {
    const change = (range, value) => f => { Object.assign(f.trees[7].children[0].children[0], { AXValue: value, AXSelectedTextRange: range }); };
    const split = run('paste', ['new'], {}, change([1, 0], '😀 old'));
    failure(split, 'ACTION_UNSUPPORTED'); assert.deepEqual(split.mutations, []);
    const full = run('paste', ['e\u0301'], {}, change([0, 2], '😀 old'));
    assert.equal(full.ok, true, JSON.stringify(full)); assert.deepEqual(full.range, [2, 0]);
    assert.equal(full.result.delivery, 'sent-verified'); assert.deepEqual(full.mutations, ['AXSelectedText']);
  });
  await t.test('unqualified targets and rich formats refuse before input with useful advice', () => {
    for (const [args, options] of [[['new'], { unqualified: true }], [['new', { format: 'html' }], {}], [['new', { format: 'md' }], {}]]) {
      const row = run('paste', args, options); failure(row, 'ACTION_UNSUPPORTED');
      assert.match(row.error.message, /Read again/); assert.deepEqual(row.mutations, []); assert.equal(row.clipboardWrites, 0);
    }
    const secure = run('paste', ['new'], { focusPath: '7/0/1' }); failure(secure, 'SECURE_FIELD');
    assert.equal(secure.valueReads, 0);
  });
  await t.test('failed AX insertion never falls back to Unicode or clipboard staging', () => {
    const row = run('paste', ['new'], { setFails: true }); failure(row, 'ACTION_UNCONFIRMED', true);
    assert.deepEqual(row.mutations, ['AXSelectedText']); assert.equal(row.clipboardWrites, 0);
  });
  await t.test('unknown delivery, observation timeout and cancellation are read-first and never replayed', () => {
    for (const option of ['pasteUnconfirmed', 'pasteThrows', 'deadlineAfterPaste']) {
      const row = run('paste', ['new'], { [option]: true, shutdown: true }, f => { f.trees[7].children[0].children[0].selectedTextSettable = false; });
      failure(row, option === 'deadlineAfterPaste' ? 'DEADLINE_EXCEEDED' : 'ACTION_UNCONFIRMED', true);
      assert.deepEqual(row.mutations, ['paste']); assert.equal(row.clipboardWrites, 0); assert.equal(row.reservations, 0);
    }
    const stopped = run('paste', ['new'], { guardFailsAt: 3 }); failure(stopped, 'PERSON_TOOK_OVER');
    assert.deepEqual(stopped.mutations, []); assert.equal(stopped.clipboardWrites, 0);
  });
  await t.test('Unicode observation settles within ten polls without resending input', () => {
    const unicode = f => { f.trees[7].children[0].children[0].selectedTextSettable = false; };
    const settled = run('paste', ['new'], { pasteUnconfirmed: true, settleAtPause: 3 }, unicode);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.result.delivery, 'sent-verified'); assert.equal(settled.pauses, 3);
    assert.deepEqual(settled.mutations, ['paste']);
    const expired = run('paste', ['new'], { pasteUnconfirmed: true }, unicode);
    failure(expired, 'ACTION_UNCONFIRMED', true); assert.equal(expired.pauses, 10);
    assert.deepEqual(expired.mutations, ['paste']);
    const takeover = run('paste', ['new'], { pasteUnconfirmed: true, guardFailsAt: 5 }, unicode);
    failure(takeover, 'PERSON_TOOK_OVER', true); assert.equal(takeover.pauses, 1);
    assert.deepEqual(takeover.mutations, ['paste']);
  });
  await t.test('post-send refusal and person takeover retain unknown delivery without a pre-input subreason', () => {
    const oversized = run('paste', ['new'], { oversizeAfterWrite: true });
    failure(oversized, 'ACTION_UNSUPPORTED', true); assert.equal(Object.hasOwn(oversized.error, 'textInput'), false);
    assert.equal(oversized.error.clipboard, 'untouched'); assert.deepEqual(oversized.mutations, ['AXSelectedText']);
    const stopped = run('paste', ['new'], { guardFailsAt: 4 }); failure(stopped, 'PERSON_TOOK_OVER', true);
    assert.equal(stopped.error.personTookOver, true); assert.deepEqual(stopped.mutations, ['AXSelectedText']);
  });
  await t.test('over-limit and secure values never become an insertion baseline', () => {
    const row = run('paste', ['new'], { characterCount: 1_048_577 }); failure(row, 'ACTION_UNSUPPORTED');
    assert.equal(row.valueReads, 0); assert.deepEqual(row.mutations, []);
    const secure = run('paste', ['new'], { secureOnGuard: 2 }); failure(secure, 'SECURE_FIELD');
    assert.deepEqual(secure.mutations, []);
  });
  await t.test('every clipboard representation is opaque to strict text delivery', () => {
    const bytes = value => Buffer.from(value).toString('base64');
    const originals = [[], [{ text: '' }], [{ 'public.utf8-plain-text': bytes('O'), 'public.rtf': bytes('rich') }, { 'public.png': bytes('image') }],
      [{ 'unknown.lazy': bytes('unreadable') }], [{ 'public.file-url': bytes('file:///fixture') }],
      [{ 'com.apple.pasteboard.promised-file-url': '' }], [{ 'custom.lazy-text': '' }],
      [{ 'org.nspasteboard.ConcealedType': '', text: bytes('secret') }], [{ 'org.nspasteboard.TransientType': '' }],
      [{ text: bytes('T'), 'translated.format': '' }], [{ 'over-budget-provider': bytes('not materialized') }]];
    for (const boardItems of originals) {
      const row = run('paste', ['new'], { boardItems });
      assert.equal(row.ok, true, JSON.stringify(row)); assert.equal(row.clipboardRestored, true);
      assert.equal(row.clipboardWrites, 0); assert.equal(row.reservations, 0);
    }
  });
  await t.test('malformed semantic arguments cannot reach input', () => {
    for (const [method, args] of [['setValue', [2, {}]], ['setValue', [true, 'v']], ['setValue', [2, null]],
      ['selectText', [2, '']], ['selectText', [2, 'old', { selectionType: 'all' }]], ['selectText', [2, 'old', { unknown: 1 }]],
      ['paste', ['new', { format: 'other' }]], ['paste', ['new', { preserve: false }]], ['performSecondaryAction', [5, '']]]) {
      const row = run(method, args); failure(row, 'INVALID_PARAMS'); assert.deepEqual(row.mutations, []); assert.equal(row.clipboardWrites, 0);
    }
  });
});
