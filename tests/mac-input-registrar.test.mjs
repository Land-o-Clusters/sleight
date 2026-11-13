import test, { after } from 'node:test';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_ACTION_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
const parentMutations = {
  capability: ['mac-driver/input-registrar.mjs', 'registrars.get(value) === driver', 'true'],
  forbidden: ['mac-safety.mjs', 'if ((host || forbidden) && !lifted)', 'if (false)'],
  protected: ['mac-safety.mjs', 'if (isOwnHost(id, app.app, app.name, app.path))', 'if (false)'],
};
let mutationHook;
if (process.env.GL1_PARENT_MUTANT) {
  const [file, before, after] = parentMutations[process.env.GL1_PARENT_MUTANT];
  const target = new URL('../plugins/sleight/lib/' + file, import.meta.url).href;
  mutationHook = registerHooks({ load(url, context, next) {
    const loaded = next(url, context);
    if (url !== target) return loaded;
    assert.ok(String(loaded.source).includes(before), 'parent mutation anchor');
    return { ...loaded, source: String(loaded.source).replace(before, after) };
  } });
}
const { prepareMacInputRegistrar, MAC_INPUT_GATE_NOTICES } = await import('../plugins/sleight/lib/mac-driver/input-registrar.mjs');
const { createMacSafety, MAC_WINDOW_REFUSALS } = await import('../plugins/sleight/lib/mac-safety.mjs');
const { createMacRuntimeTools } = await import('../plugins/sleight/lib/mac-driver/runtime-tools.mjs');
const { createOwnRuntime } = await import('../plugins/sleight/lib/runtime-select.mjs');
const { createEvaluator } = await import('../plugins/sleight/lib/repl/worker.mjs');
mutationHook?.deregister();
import { nativeToolsSkip } from './fixtures/mac-driver-tools.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const window = { windowId: '42', pid: 321, processStart: '100.25', bundleId: 'org.test.fixture', app: 'Fixture',
  title: 'Draft', onScreen: true, minimized: false, layer: 0, hidden: false, identityVerified: true,
  bounds: { x: 0, y: 0, width: 400, height: 300 } };
const binding = { windowId: window.windowId, processStart: window.processStart };
const inventory = { apps: [{ id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }],
  windows: [window], trees: { 42: { AXRole: 'AXWindow', AXTitle: 'Draft', AXMinimized: false, AXFullScreen: false,
    pid: 321, frame: window.bounds,
    children: [{ AXRole: 'AXButton', AXTitle: 'Press', pid: 321, frame: { x: 20, y: 20, width: 40, height: 20 } }] } } };
let root;
const binaries = new Map();
const harness = String.raw`
final class InputRecordingSink: DriverPointerSink, DriverPointerPrepared {
    var posts = 0
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws { posts += 1 }
    func release(_ index: Int) throws { posts += 1 }
}
final class InputDroppingSink: DriverPointerSink, DriverPointerPrepared {
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
    func post(_ index: Int) throws {}
    func release(_ index: Int) throws {}
}
final class InputSyntheticCapture: DriverCaptureBackend {
    var scale = 2, blue = false, patch = 0
    func preflight() -> Bool { true }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        let width = 400 * scale, height = 300 * scale
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(blue ? CGColor(red: 0, green: 0, blue: 1, alpha: 1) : CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        // A small asymmetric mark exercises patch clipping and orientation.
        if patch > 0 {
            context.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            let x = patch == 1 ? 35 : 250, y = patch == 1 ? 25 : 200
            context.fill(CGRect(x: x * scale, y: (300 - y - 3) * scale, width: 7 * scale, height: 3 * scale))
        }
        return DriverCapturedImage(image: context.makeImage()!, target: target)
    }
}
let fixture = try DriverJSON.decode(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let core = DriverCore(fixture: fixture, personProviders: DriverPersonProviders(sample: {
    let at = ProcessInfo.processInfo.systemUptime
    return DriverPersonSample(at: at, hidIdle: at, frontmostPID: 999, pointerPID: nil)
}))
let runtime = DriverRuntime(core: core, nonce: ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!, clipboardCount: { 10 })
let sink = InputRecordingSink()
let capture = InputSyntheticCapture()
var keyPosts = 0
var keyEvents = [DriverObject]()
let keys = DriverKeyboard(layout: { ["c": DriverKeyboardMapping(keyCode: 8, modifiers: []), "x": DriverKeyboardMapping(keyCode: 7, modifiers: [])] }, makeEvent: { spec in { _ in
    keyPosts += 1; keyEvents.append(spec.json)
    if spec.type == "keyDown" && fixture["stopAfterPost"] as? Bool == true {
        try runtime.userStop.receive(["protocol": driverProtocol, "platform": "darwin", "nonce": ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!, "control": "release"], nonce: ProcessInfo.processInfo.environment["SLEIGHT_DRIVER_NONCE"]!)
    }
} }, ladder: { "flags-changed" },
    pause: {}, beforeInput: { request, core in try core.checkPersonBeforeInput(request) })
var semanticPosts = 0
var semanticValue: Any = false
var semanticAccess = DriverSemanticAccess.system
semanticAccess.attributes = { node, names, request in
    var result = try node.attributes(names, request: request)
    if names.contains(kAXValueAttribute) { result[kAXValueAttribute] = semanticValue }
    return result
}
semanticAccess.isSettable = { _, _, _ in true }
semanticAccess.set = { _, _, value, _ in semanticPosts += 1; semanticValue = value }
semanticAccess.parent = { node, request in
    let root = try core.boundWindow(["windowId": "42", "processStart": "100.25"], request: request).root
    return node.same(root) ? nil : root
}
let semantics = DriverSemantic(access: semanticAccess, beforeInput: { request, core in try core.checkPersonBeforeInput(request) })
runtime.registerSettleAndPerson()
runtime.registerRuntimeInputs(pointerSink: sink, keyboard: keys, semantic: semantics, captureBackend: capture,
    coordinateHitTest: fixture["coordinateHits"] as? Bool == true ? { _ in
        let root = (fixture["trees"] as! DriverObject)["42"] as! DriverObject
        let child = (root["children"] as! [DriverObject])[0]
        return DriverNode(fake: child.merging(["AXParent": root]) { _, new in new }, path: "42/0")
    } : nil)
runtime.register(method: "fixtureCapture") { request, _ in
    let options = (request.params["args"] as? [DriverObject])?.first ?? [:]
    capture.blue = driverBoolean(options["blue"]) ?? false
    capture.patch = driverInteger(options["patch"]) ?? 0
    capture.scale = driverInteger(options["scale"]) ?? 2
    capturePixelsBroken = driverBoolean(options["breakPixels"]) ?? false
    captureScaleBroken = driverBoolean(options["breakScale"]) ?? false
    captureWitnessBroken = driverBoolean(options["breakWitness"]) ?? false
    return [:]
}
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
runtime.register(method: "fixtureReadStats") { _, core in ["walks": core.nextRead, "readId": core.maps["42"]?.id ?? 0] }
runtime.register(method: "fixtureMapDamage") { _, core in core.maps["42"]?.text = "Changed retained tree"; return [:] }
runtime.register(method: "fixtureCaptureCost") { request, core in
    let args = (request.params["args"] as? [DriverObject])?.first ?? [:]
    let walks = driverInteger(args["walks"]) ?? 0, samples = driverInteger(args["samples"]) ?? 5
    let binding: DriverObject = ["windowId": "42", "processStart": "100.25"]
    let service = DriverCaptureService(backend: capture)
    let captureRequest = DriverRequest(copying: request, method: "getScreenshot", params: binding)
    var durations: [Double] = []
    for _ in 0..<samples {
        let start = ProcessInfo.processInfo.systemUptime
        if walks > 0 { _ = try core.readTree(binding, request: request) }
        _ = try service.read(request: captureRequest, combined: false,
            bind: { try core.boundWindow(binding, request: request).window }, tree: { [:] })
        if walks > 1 { _ = try core.readTree(binding, request: request) }
        durations.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
    }
    return ["durationsMS": durations, "walks": walks * samples]
}
runtime.register(method: "fixtureKeyEvents") { _, _ in ["events": keyEvents] }
runtime.register(method: "fixtureSemanticStats") { _, _ in ["writes": semanticPosts, "value": semanticValue] }
runtime.register(method: "fixtureStats") { _, _ in ["pointer": sink.posts, "keys": keyPosts] }
runtime.register(method: "ping") { _, _ in ["protocol": driverProtocol, "platform": "darwin", "apiVersion": driverAPIVersion,
    "build": driverBuild, "healthy": true, "methods": runtime.methods] }
DispatchQueue.global().async { runtime.serve() }
RunLoop.main.run()
`;
function prepareRegistrarFixture(enabled) {
  if (binaries.has(enabled)) return;
  if (!root) root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-input-registrar-')));
  const source = macDriverSource(), at = source.lastIndexOf('\ndriverMain()');
  assert.ok(at > 0);
  let body = source.slice(0, at)
    .replace('static func regionHash(_ screenshot: DriverObject, bounds: CGRect, point: CGPoint) throws -> Data {',
      'static func regionHash(_ screenshot: DriverObject, bounds: CGRect, point: CGPoint) throws -> Data { if capturePixelsBroken { return Data([0]) }')
    .replace('if !beforeMap.coordinateMatches(map)', 'if !captureWitnessBroken && !beforeMap.coordinateMatches(map)')
    .replace('guard driverInteger(oldCapture["sourcePixelWidth"]) == image.image.width,\n                                  driverInteger(oldCapture["sourcePixelHeight"]) == image.image.height else',
      'guard captureScaleBroken || (driverInteger(oldCapture["sourcePixelWidth"]) == image.image.width && driverInteger(oldCapture["sourcePixelHeight"]) == image.image.height) else');
  assert.notEqual(body, source.slice(0, at));
  const variants = {
    disabled: ['let driverInputGateEnabled = true', 'let driverInputGateEnabled = false'],
    keyboard: ['try post(originalPid)', '()'],
    semantic: ['try semantics.handle(request, core: core)', '[:]'],
    pointer: ['sink: pointerSink ?? DriverPointerNativeSink()', 'sink: InputDroppingSink()'],
    geometry: ['geometry: trustedGeometry,', 'geometry: nil,'],
    stop: ['if stopped { throw DriverFault("USER_STOPPED") }', 'if false { throw DriverFault("USER_STOPPED") }'],
    clipboard: ['try Self.refuseClipboardKeys(specs, layout: currentLayout)', '// broken clipboard admission'],
    person: ['try core.checkPersonBeforeInput(request)', '// broken person admission'],
  };
  if (enabled && process.env.GL1_NATIVE_MUTANT) {
    const [before, after] = variants[process.env.GL1_NATIVE_MUTANT];
    assert.ok(body.includes(before), 'native mutation anchor'); body = body.replaceAll(before, after);
  }
  if (!enabled) body = body.replace('let driverInputGateEnabled = true', 'let driverInputGateEnabled = false');
  const path = join(root, enabled ? 'fixture.swift' : 'disabled.swift');
  writeFileSync(path, body + '\nvar capturePixelsBroken = false, captureScaleBroken = false, captureWitnessBroken = false\n' + harness);
  {
    const binary = join(root, enabled ? 'gate' : 'preview');
    const result = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc',
      '-module-cache-path', join(root, 'modules'), path, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000 });
    assert.equal(result.status, 0, result.stderr || String(result.error)); binaries.set(enabled, binary);
  }
}
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
let serial = 0;
function client(t, enabled, extraEnv = {}, fixture = inventory) {
  prepareRegistrarFixture(enabled);
  const path = join(root, `fixture-${++serial}.json`); writeFileSync(path, JSON.stringify(fixture));
  const value = createMacDriverClient({ platform: 'darwin', requiredMethods: ['ping', 'inputGateState'],
    prepare: async () => ({ status: 'ready', spawn: ({ nonce }) => spawn(binaries.get(enabled), [path], {
      env: { ...process.env, ...extraEnv, SLEIGHT_DRIVER_NONCE: nonce }, stdio: ['pipe', 'pipe', 'pipe'],
    }) }) });
  t.after(() => value.close()); return value;
}
const native = (name, fn) => test(name, { skip: nativeToolsSkip }, fn);

test('input gate result notices have a separate conditional pin and no startup text', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/prompt-default.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(MAC_INPUT_GATE_NOTICES)).digest('hex'), baseline.macInputGateNotices);
  assert.equal(Buffer.byteLength(Object.values(MAC_INPUT_GATE_NOTICES).join('\n')), 44);
});

native('broken disabled-input helper refuses all actions even with gate-looking environment values', async t => {
  const driver = client(t, false, { SLEIGHT_DRIVER_INPUT_GATE: '1', SLEIGHT_INPUT_GATE: '1', SLEIGHT_RUNTIME_INPUT: '1' });
  const hello = await driver.ping();
  assert.deepEqual(await driver.request('inputGateState', {}), { enabled: false });
  await assert.rejects(prepareMacInputRegistrar(driver, hello.build), /MAC_INPUT_GATE_DISABLED/);
  for (const method of [...DRIVER_ACTION_METHODS, 'stuckMenuEscape']) {
    assert.equal(hello.methods.includes(method), false, method);
    const args = method === 'paste' ? ['text'] : ['setValue', 'selectText', 'performSecondaryAction'].includes(method) ? [1, 'text'] : [];
    await assert.rejects(driver.request(method, { ...binding, readId: 1, args }), { code: 'DRIVER_VERSION_MISMATCH' });
  }
  for (const [script, params] of [['stuck-escape.js', {}], ['select-window.js', {}],
    ['menubar.js', { op: 'open' }], ['open-file-window.js', { op: 'open' }], ['front-restore.js', { action: 'finish' }]])
    await assert.rejects(driver.request('localTool', { args: [script, params] }), { code: 'METHOD_NOT_FOUND' });
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 0, keys: 0 });
  // Bypass the client's method advertisement check to exercise the actual
  // native refusal too. This executable has only fixture/recording providers.
  const path = join(root, `raw-${++serial}.json`); writeFileSync(path, JSON.stringify(inventory));
  const methods = [...DRIVER_ACTION_METHODS, 'stuckMenuEscape'];
  const nonce = 'a'.repeat(64);
  const requests = methods.map((method, index) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
    id: index + 1, method, params: { ...binding, readId: 1, args: [], inputGate: true }, deadline: Date.now() + 10000 }));
  const raw = spawnSync(binaries.get(false), [path], { env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce,
    SLEIGHT_DRIVER_INPUT_GATE: '1' }, killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000, input: requests.map(JSON.stringify).join('\n') + '\n' });
  assert.equal(raw.status, 0, raw.stderr);
  const replies = raw.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(replies.length, methods.length);
  for (const reply of replies) assert.equal(reply.error?.code, 'METHOD_NOT_FOUND');
});

native('the installed build installs real input handlers and preserves person/read/Space refusals', async t => {
  const driver = client(t, true);
  const hello = await driver.ping();
  for (const method of DRIVER_ACTION_METHODS) assert.equal(hello.methods.includes(method), true, method);
  assert.deepEqual(await driver.request('inputGateState', {}), { enabled: true });
  const read = await driver.request('getAXState', binding);
  const person = await driver.request('personState', binding);
  const params = { ...binding, readId: read.readId, args: [1], personToken: person.token };
  await assert.rejects(driver.request('click', { ...params, personToken: undefined }), { code: 'INVALID_PARAMS' });
  await assert.rejects(driver.request('click', { ...params, personToken: 'forged' }), { code: 'PERSON_TOOK_OVER' });
  await assert.rejects(driver.request('click', { ...params, readId: read.readId + 1 }), { code: 'STALE_READ' });
  const result = await driver.request('click', params);
  assert.equal(result.delivery, 'sent-unverified');
  await driver.request('pressKey', { ...params, args: ['Escape'] });
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 2, keys: 2 });
  await assert.rejects(driver.request('click', { ...params, args: [[80, 60]] }),
    { code: 'CAPTURE_GEOMETRY_CHANGED', delivery: 'not-sent', retry: 'safe' });
  const capture = await driver.request('getScreenshot', { ...binding, scale: 'point' });
  assert.equal(capture.geometry.pixelWidth, 400); assert.equal(capture.geometry.pixelHeight, 300);
  // The production registrar supplies no fake coordinate hit-test adapter.
  // CB1H must refuse this fixture before dispatch even after geometry is known.
  await assert.rejects(driver.request('click', { ...params, coordinateReadId: capture.coordinateReadId, args: [[80, 60]] }),
    { code: 'ACTION_UNSUPPORTED', message: 'Coordinate fixtures require an injected hit test.', delivery: 'not-sent', retry: 'safe' });
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 2, keys: 2 });
  await assert.rejects(driver.request('paste', { ...params, args: ['never touch the clipboard'] }), { code: 'ACTION_UNSUPPORTED' });
  const offSpace = client(t, true, {}, { ...inventory, windows: [{ ...window, onScreen: false }] });
  const offRead = await offSpace.request('getAXState', binding), offPerson = await offSpace.request('personState', binding);
  await assert.rejects(offSpace.request('click', { ...params, readId: offRead.readId, personToken: offPerson.token }),
    { code: 'NO_WINDOWS_AVAILABLE', message: MAC_WINDOW_REFUSALS.otherSpace });
  assert.deepEqual(await offSpace.request('fixtureStats', {}), { pointer: 0, keys: 0 });
});

native('installed registrar types through the native keyboard and refuses Copy and Cut before posts', async t => {
  const driver = client(t, true);
  const read = await driver.request('getAXState', binding), person = await driver.request('personState', binding);
  const params = { ...binding, readId: read.readId, personToken: person.token };
  const typed = await driver.request('typeText', { ...params, args: ['glide'] });
  assert.equal(typed.delivery, 'sent-unverified');
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 0, keys: 2 });
  assert.deepEqual((await driver.request('fixtureKeyEvents', {})).events.map(event => event.unicode), ['glide', 'glide']);
  for (const chord of ['Command+c', 'Command+x']) {
    await assert.rejects(driver.request('pressKey', { ...params, args: [chord] }),
      { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', clipboard: 'untouched' });
    assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 0, keys: 2 });
  }
});

native('installed registrar stops mid-type through DriverUserStop and refuses later input', async t => {
  const driver = client(t, true, {}, { ...inventory, stopAfterPost: true });
  const read = await driver.request('getAXState', binding), person = await driver.request('personState', binding);
  const params = { ...binding, readId: read.readId, personToken: person.token };
  await assert.rejects(driver.request('typeText', { ...params, args: ['a'.repeat(100)] }), { code: 'USER_STOPPED' });
  const stats = await driver.request('fixtureStats', {});
  assert.equal(stats.keys, 2, 'one attempted key down and its cleanup key up');
  await assert.rejects(driver.request('pressKey', { ...params, args: ['Escape'] }), { code: 'USER_STOPPED' });
  assert.deepEqual(await driver.request('fixtureStats', {}), stats);
});

native('installed registrar reaches the semantic AX sink', async t => {
  const data = structuredClone(inventory);
  data.trees[42].children[0].AXRole = 'AXCheckBox';
  const driver = client(t, true, {}, data);
  const read = await driver.request('getAXState', binding), person = await driver.request('personState', binding);
  const result = await driver.request('setValue', { ...binding, readId: read.readId, personToken: person.token, args: [1, true] });
  assert.equal(result.delivery, 'sent-verified');
  assert.deepEqual(await driver.request('fixtureSemanticStats', {}), { writes: 1, value: true });
});

native('UC2D canvas pixel matching and Retina drift use the real capture registrar without a desktop', async t => {
  const data = structuredClone(inventory);
  data.coordinateHits = true; data.trees[42].children[0].AXRole = 'AXCanvas';
  const driver = client(t, true, {}, data);
  const read = await driver.request('getAXState', binding);
  const person = await driver.request('personState', binding);
  const params = { ...binding, readId: read.readId, args: [[40, 30]], personToken: person.token };
  const capture = await driver.request('getScreenshot', { ...binding, scale: 'point' });
  const click = { ...params, coordinateReadId: capture.coordinateReadId };
  await driver.request('fixtureCapture', { args: [{ blue: true }] });
  await assert.rejects(driver.request('click', click), { code: 'TARGET_CHANGED', delivery: 'not-sent' });
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 0, keys: 0 });
  await driver.request('fixtureCapture', { args: [{ blue: true, breakPixels: true }] });
  assert.equal((await driver.request('click', click)).delivery, 'sent-unverified', 'the disabled pixel hash admits the changed canvas');
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 2, keys: 0 });
  await driver.request('fixtureCapture', { args: [{ blue: false, scale: 1 }] });
  await assert.rejects(driver.request('click', click), { code: 'CAPTURE_SCALE_INVALID', delivery: 'not-sent' });
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 2, keys: 0 });
  await driver.request('fixtureCapture', { args: [{ blue: false, scale: 1, breakScale: true }] });
  assert.equal((await driver.request('click', click)).delivery, 'sent-unverified', 'the disabled scale check admits display drift');
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 4, keys: 0 });
  await driver.request('fixtureCapture', { args: [{ blue: false, scale: 2 }] });
  assert.equal((await driver.request('click', click)).delivery, 'sent-unverified');
  assert.deepEqual(await driver.request('fixtureStats', {}), { pointer: 6, keys: 0 });
});

function safety(driver, inputRegistrar) {
  const guard = createMacSafety({ driver, inputRegistrar,
    lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} }, approve: async () => true,
    policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 900, path: '/usr/bin/node' }],
    permissions: { app() {}, page() {}, sitesLimited: () => false } });
  guard.setPolicy({ checkPause() {}, beforeAction: async ({ args, personToken }) => ({ args, personToken }) });
  return guard;
}

for (const [name, bundleId, code] of [
  ['Terminal', 'com.apple.Terminal', 'FORBIDDEN_TARGET'],
  ['ChatGPT', 'com.openai.chat', 'FORBIDDEN_TARGET'],
  ['consent-host', 'org.test.consent', 'OWN_HOST_REFUSED'],
]) test(`installed parent refuses ${name} before a read or input`, async () => {
  const calls = [], target = { ...window, bundleId, app: name };
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), request: async method => {
    calls.push(method);
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: bundleId, name, pid: target.pid, processStart: target.processStart }, windows: [target] };
    if (method === 'verifyWindowIdentity') return { window: target };
    return { window: target, readId: 1, text: '0 window\n1 button Always allow' };
  } };
  const guard = safety(driver, await prepareMacInputRegistrar(driver, 'a'.repeat(64)));
  try {
    await assert.rejects(guard.request('getApp', { selector: 'Fixture' }), { code });
    assert.equal(calls.includes('getAXState'), false);
    assert.equal(calls.some(method => DRIVER_ACTION_METHODS.includes(method)), false);
  } finally { await guard.close(); }
});
for (const reason of ['person-active', 'person-took-over', 'person-unknown'])
  test(`UC2B2 parent distinguishes initial activity from previous takeover: ${reason}`, async () => {
    let inputs = 0;
    const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
      if (method === 'inputGateState') return { enabled: true };
      if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [window] };
      if (method === 'verifyWindowIdentity') return { window };
      if (method === 'personState') return { token: 'host-token', personTookOver: true, reason };
      if (method === 'click') { inputs++; return { window, delivery: 'sent-unverified' }; }
      return { window, text: 'Window: Draft', readId: 1 };
    } };
    const guard = safety(driver, await prepareMacInputRegistrar(driver, 'a'.repeat(64)));
    await guard.request('getApp', { selector: 'Fixture' });
    if (reason === 'person-active') {
      await guard.request('click', { ...binding, readId: 1, args: [1] });
      assert.equal(inputs, 1);
    } else {
      await assert.rejects(guard.request('click', { ...binding, readId: 1, args: [1] }), { code: 'PERSON_TOOK_OVER' });
      assert.equal(inputs, 0);
    }
  });
test('unregistered parent refuses all input methods and JSON/cell/context/option lookalikes before driver access', async () => {
  const calls = [], driver = { request: async (...args) => { calls.push(args); assert.fail('no driver access'); } };
  const forged = [undefined, true, {}, { enabled: true }, { inputGate: true }, runInNewContext('({enabled:true})')];
  for (const inputRegistrar of forged) {
    const guard = safety(driver, inputRegistrar);
    for (const method of DRIVER_ACTION_METHODS)
      await assert.rejects(guard.request(method, { ...binding, readId: 1, args: [], inputGate: true },
        { inputRegistrar, inputGate: true }), { code: 'METHOD_NOT_FOUND' });
    const local = createMacRuntimeTools({ driver: { ...driver, ping: async () => ({}) }, inputRegistrar });
    assert.deepEqual(local.localTools.tools, []);
  }
  assert.equal(calls.length, 0);
});

test('a host capability belongs to one driver and cannot be copied through JSON or cell code', async t => {
  const calls = [];
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }), async close() {}, async request(method, params) {
    calls.push([method, params]);
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window };
    if (method === 'personState') return { token: 'host-token', personTookOver: false };
    return { window, text: 'Window: Draft', readId: 1, delivery: method === 'click' ? 'sent-unverified' : undefined };
  } };
  const registrar = await prepareMacInputRegistrar(driver, 'a'.repeat(64));
  const guard = safety(driver, registrar);
  await guard.request('getApp', { selector: 'Fixture' });
  await guard.request('click', { ...binding, readId: 1, args: [1] });
  assert.equal(calls.at(-1)[1].personToken, 'host-token');
  await assert.rejects(guard.request('click', { ...binding, readId: 1, args: [1], personToken: 'model' }), { code: 'INVALID_PARAMS' });
  const gateTools = createMacRuntimeTools({ driver, inputRegistrar: registrar });
  assert.deepEqual(gateTools.localTools.tools.map(tool => tool.name).sort(), ['drag', 'open_file', 'select_window']);
  for (const [otherDriver, value] of [[driver, structuredClone(registrar)], [{ ...driver }, registrar]])
    await assert.rejects(safety(otherDriver, value).request('click', {}), { code: 'METHOD_NOT_FOUND' });
  const runtime = createOwnRuntime({ driver, inputRegistrar: registrar,
    lease: { release() {}, close() {} } });
  t.after(() => runtime.close());
  assert.deepEqual(runtime.localServices.localTools.tools.map(tool => tool.name).sort(), ['drag', 'open_file', 'select_window']);
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/build.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SLEIGHT_DRIVER_INPUT_GATE/);
});

test('the registrar requires the exact expected helper source build', async t => {
  const build = 'a'.repeat(64);
  const driver = { ping: async () => ({ build }), request: async () => ({ enabled: true }) };
  await t.test('matching build passes', async () => {
    const registrar = await prepareMacInputRegistrar(driver, build);
    assert.deepEqual(createMacRuntimeTools({ driver, inputRegistrar: registrar }).localTools.tools.map(t => t.name).sort(),
      ['drag', 'open_file', 'select_window']);
  });
  for (const [name, actual] of [['mismatched', 'b'.repeat(64)], ['missing', undefined], ['null', null],
    ['number', 123], ['object', {}], ['array', [build]]])
    await t.test(`actual build ${name} refuses`, () =>
      assert.rejects(prepareMacInputRegistrar({ ...driver, ping: async () => ({ build: actual }) }, build), /MAC_INPUT_GATE_DISABLED/));
  for (const [name, expected] of [['missing', undefined], ['null', null], ['number', 123], ['object', {}], ['empty', ''], ['short', 'a']])
    await t.test(`expected build ${name} refuses`, () =>
      assert.rejects(prepareMacInputRegistrar(driver, expected), /MAC_INPUT_GATE_DISABLED/));
});

test('extra keys in the gate reply refuse a registrar', async () => {
  const driver = { ping: async () => ({ build: 'a'.repeat(64) }),
    request: async () => ({ enabled: true, extra: true }) };
  await assert.rejects(prepareMacInputRegistrar(driver, 'a'.repeat(64)), /MAC_INPUT_GATE_DISABLED/);
});

test('the REPL context has no process or require and its worker imports no registrar', async t => {
  const evaluator = createEvaluator({ platform: 'darwin', request: () => assert.fail('no driver access') });
  t.after(() => evaluator.close());
  const result = await evaluator.evaluate('nodeRepl.write(JSON.stringify([typeof process, typeof require, "process" in globalThis, "require" in globalThis]))');
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: 'text', text: '["undefined","undefined",false,false]' }]);
  const source = readFileSync(new URL('../plugins/sleight/lib/repl/worker.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /input-registrar[.]mjs/);
});

test('the parent refuses off-Space input with a valid registrar before person sampling or input dispatch', async () => {
  const calls = [], driver = { ping: async () => ({ build: 'a'.repeat(64) }), async request(method) {
    calls.push(method);
    if (method === 'inputGateState') return { enabled: true };
    if (method === 'resolveApp') return { app: { id: window.bundleId, name: window.app, pid: window.pid, processStart: window.processStart }, windows: [window] };
    if (method === 'verifyWindowIdentity') return { window: { ...window, onScreen: false } };
    if (method === 'personState') return { token: 'host-token', personTookOver: false };
    return { window: { ...window, onScreen: false }, text: 'Window: Draft', readId: 1 };
  } };
  const guard = safety(driver, await prepareMacInputRegistrar(driver, 'a'.repeat(64)));
  await guard.request('getApp', { selector: 'Fixture' }); calls.length = 0;
  await assert.rejects(guard.request('click', { ...binding, readId: 1, args: [1] }),
    { code: 'NO_WINDOWS_AVAILABLE', message: MAC_INPUT_GATE_NOTICES.otherSpace });
  assert.deepEqual(calls, ['verifyWindowIdentity']);
});

native('UC2D2 screenshot cost with a 198-row recorded-shape tree and a synthetic image sink', async t => {
  const data=structuredClone(inventory);
  data.trees[42].children=Array.from({length:198},(_,i)=>({AXRole:'AXButton',AXTitle:'Row '+i,pid:321,frame:{x:20,y:20+i,width:40,height:1}}));
  const driver=client(t,true,{},data), result={};
  for (const walks of [0,1,2]) {
    const measured=await driver.request('fixtureCaptureCost',{args:[{walks,samples:10}]});
    assert.equal(measured.durationsMS.length,10); assert.equal(measured.walks,walks*10);
    result[walks]={meanMS:measured.durationsMS.reduce((sum,n)=>sum+n,0)/10,walks:measured.walks};
  }
  const start=performance.now(), before=await driver.request('fixtureReadStats',{});
  for (let i=0;i<10;i++) await driver.request('getScreenshot',binding);
  const after=await driver.request('fixtureReadStats',{});
  result.optimized={meanMS:(performance.now()-start)/10,walks:after.walks-before.walks};
  assert.equal(result.optimized.walks,10);
  console.log('UC2D2 screenshot cost '+JSON.stringify(result));
});

native('UC2D2 non-uniform capture patches ignore remote marks and refuse local marks', async t=>{
  const data=structuredClone(inventory); data.coordinateHits=true; data.trees[42].children[0].AXRole='AXCanvas';
  const driver=client(t,true,{},data), read=await driver.request('getAXState',binding), person=await driver.request('personState',binding);
  const capture=await driver.request('getScreenshot',{...binding,scale:'point'});
  const params={...binding,readId:read.readId,coordinateReadId:capture.coordinateReadId,args:[[40,30]],personToken:person.token};
  await driver.request('fixtureCapture',{args:[{patch:2}]});
  assert.equal((await driver.request('click',params)).delivery,'sent-unverified');
  await driver.request('fixtureCapture',{args:[{patch:1}]});
  await assert.rejects(driver.request('click',params),{code:'TARGET_CHANGED'});
  await driver.request('fixtureCapture',{args:[{patch:1,breakPixels:true}]});
  assert.equal((await driver.request('click',params)).delivery,'sent-unverified');
  assert.deepEqual(await driver.request('fixtureStats',{}),{pointer:4,keys:0});
});

native('UC2D2 screenshot reuses one retained walk and a mismatched witness refuses coordinates',async t=>{
  const data=structuredClone(inventory); data.coordinateHits=true;
  const driver=client(t,true,{},data), read=await driver.request('getAXState',binding), person=await driver.request('personState',binding);
  const capture=await driver.request('getScreenshot',{...binding,scale:'point'});
  assert.deepEqual(await driver.request('fixtureReadStats',{}),{walks:2,readId:read.readId});
  assert.equal(capture.coordinateReadId,2);
  const params={...binding,readId:read.readId,coordinateReadId:capture.coordinateReadId,args:[[40,30]],personToken:person.token};
  assert.equal((await driver.request('click',params)).delivery,'sent-unverified');
  await driver.request('fixtureMapDamage',{});
  const changed=await driver.request('getScreenshot',{...binding,scale:'point'});
  await assert.rejects(driver.request('click',{...params,coordinateReadId:changed.coordinateReadId}),{code:'TARGET_CHANGED'});
  await driver.request('fixtureCapture',{args:[{breakWitness:true}]});
  const broken=await driver.request('getScreenshot',{...binding,scale:'point'});
  assert.equal((await driver.request('click',{...params,coordinateReadId:broken.coordinateReadId})).delivery,'sent-unverified');
  const combined=await driver.request('getAXStateAndScreenshot',binding);
  assert.equal(combined.readId,5); assert.equal(combined.coordinateReadId,5);
  assert.deepEqual(await driver.request('fixtureReadStats',{}),{walks:5,readId:5});
});
