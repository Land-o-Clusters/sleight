import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import * as relay from '../plugins/sleight/lib/relay.mjs';
const { imageSize, screenshotOf } = relay;

const sourceURL = new URL('../plugins/sleight/lib/mac-driver/native/DriverCapture.swift', import.meta.url);

// This executable only draws synthetic pixels into memory. Its backend cannot
// enumerate apps/windows, query TCC, capture the desktop or create an NSWindow.
const harness = String.raw`
import Foundation
import CoreGraphics
typealias DriverObject = [String: Any]
struct DriverFault: Error {
    let code: String
    let message: String
    let unhealthy: Bool
    init(_ code: String, _ message: String? = nil, unhealthy: Bool = false) {
        self.code = code; self.message = message ?? code; self.unhealthy = unhealthy
    }
}
func driverInteger(_ value: Any?) -> Int? {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
          n.doubleValue.rounded() == n.doubleValue, abs(n.doubleValue) <= 9_007_199_254_740_991 else { return nil }
    return n.intValue
}
final class DriverRequest {
    let params: DriverObject
    let deadline: Double
    init(_ params: DriverObject, seconds: Double = 3) {
        self.params = params; deadline = ProcessInfo.processInfo.systemUptime + seconds
    }
    var remaining: Double { max(0, deadline - ProcessInfo.processInfo.systemUptime) }
    func check() throws { if remaining <= 0 { throw DriverFault("DEADLINE_EXCEEDED", unhealthy: true) } }
    func keys(_ required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(params.keys)), Set(params.keys).isSubset(of: required.union(optional)) else {
            throw DriverFault("INVALID_PARAMS")
        }
    }
}
final class FakeInventory { var fixture: DriverObject? }
struct DriverBoundWindow { let window: DriverObject }
final class DriverCore {
    let inventory = FakeInventory()
    var maps = ["71": 9]
    func boundWindow(_ params: DriverObject, request: DriverRequest) throws -> DriverBoundWindow {
        DriverBoundWindow(window: window())
    }
    func readTree(_ params: DriverObject, request: DriverRequest) throws -> DriverObject {
        ["window": window(), "text": "fixture tree", "readId": 9, "truncated": false]
    }
}
final class DriverRuntime {
    typealias Handler = (DriverRequest, DriverCore) throws -> DriverObject
    var handlers: [String: Handler] = [:]
    func register(method: String, handler: @escaping Handler) { handlers[method] = handler }
}
func window() -> DriverObject {
    ["windowId": "71", "pid": 42, "processStart": "10.20", "identityVerified": true,
     "minimized": false, "onScreen": true, "app": "Fixture", "title": "Covered",
     "bounds": ["x": -320.0, "y": 41.5, "width": 120.0, "height": 80.0]]
}
final class FakeCapture: DriverCaptureBackend {
    var permission = true
    var mode = "ok"
    var captures = 0
    var preflights = 0
    let started = DispatchSemaphore(value: 0)
    let treeStarted = DispatchSemaphore(value: 0)
    func preflight() -> Bool { preflights += 1; return permission }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        captures += 1; started.signal()
        if mode == "parallel" {
            guard treeStarted.wait(timeout: .now() + request.remaining) == .success else { throw DriverFault("NOT_PARALLEL") }
        }
        if mode == "failure" { throw DriverFault("CAPTURE_UNAVAILABLE") }
        if mode == "deadline" {
            return try DriverCaptureSlot<DriverCapturedImage>().wait(request)
        }
        var w = 240, h = 160
        if mode == "oneX" { w = 120; h = 80 }
        if mode == "fractional" { w = 150; h = 100 }
        if mode == "badScale" { w = 240; h = 80 }
        if mode == "hugeScale" { w = 600; h = 400 }
        let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [0.1, 0.2, 0.3, 1])!)
        context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        // Asymmetric quadrants detect a vertical flip or a crop during resizing.
        context.setFillColor(CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [1, 0, 0, 1])!)
        context.fill(CGRect(x: 0, y: 0, width: w / 2, height: h / 2))
        context.setFillColor(CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!, components: [0, 0, 1, 1])!)
        context.fill(CGRect(x: w / 2, y: h / 2, width: w / 2, height: h / 2))
        var returned = target.window
        if mode == "wrongImageOwner" { returned["pid"] = 99 }
        return DriverCapturedImage(image: context.makeImage()!, target: try DriverCaptureTarget(returned))
    }
}
func run(_ options: DriverObject) throws -> DriverObject {
    let mode = options["mode"] as? String ?? "ok"
    var initial = window()
    if let patch = options["window"] as? DriverObject { for (k, v) in patch { initial[k] = v } }
    let fake = FakeCapture(); fake.mode = mode; fake.permission = mode != "denied"
    let service = DriverCaptureService(backend: fake)
    var params: DriverObject = ["windowId": "71", "processStart": "10.20"]
    if let override = options["params"] as? DriverObject { params = override }
    let combined = options["combined"] as? Bool ?? true
    let request = DriverRequest(params, seconds: mode == "expired" ? -1 : mode == "deadline" ? 0.03 : 3)
    if mode == "regionHashes" {
        let target = try DriverCaptureTarget(initial)
        func encoded(_ changed: Bool) throws -> DriverObject {
            let context = CGContext(data: nil, width: 240, height: 160, bitsPerComponent: 8, bytesPerRow: 960,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 240, height: 160))
            if changed {
                context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); context.fill(CGRect(x: 16, y: 136, width: 8, height: 8))
            }
            return try DriverCaptureService.fields(DriverCapturedImage(image: context.makeImage()!, target: target), request: request)["screenshot"] as! DriverObject
        }
        let baseline = try encoded(false), changed = try encoded(true), bounds = target.bounds
        let topLeft = CGPoint(x: bounds.minX + 10, y: bounds.minY + 10)
        let bottomRight = CGPoint(x: bounds.maxX - 10, y: bounds.maxY - 10)
        func hash(_ image: DriverObject, _ point: CGPoint) throws -> Data { try DriverCaptureService.regionHash(image, bounds: bounds, point: point) }
        return ["ok": true, "repeatEqual": try hash(baseline, topLeft) == hash(baseline, topLeft),
            "targetChanged": try hash(baseline, topLeft) != hash(changed, topLeft),
            "outsideUnchanged": try hash(baseline, bottomRight) == hash(changed, bottomRight),
            "cornerChanged": try hash(baseline, bounds.origin) != hash(changed, bounds.origin)]
    }
    if mode.hasPrefix("adapter") {
        let runtime = DriverRuntime(), core = DriverCore()
        if mode == "adapterFixture" {
            core.inventory.fixture = [:]; runtime.registerCapture()
        } else {
            fake.mode = mode == "adapterFailure" ? "failure" : "ok"
            runtime.registerCapture(backend: fake)
        }
        do {
            let method = combined ? "getAXStateAndScreenshot" : "getScreenshot"
            let result = try runtime.handlers[method]!(request, core)
            return ["ok": true, "result": result, "methods": runtime.handlers.keys.sorted()]
        } catch let fault as DriverFault {
            return ["ok": false, "code": fault.code, "maps": core.maps.count]
        }
    }
    var binds = 0, walks = 0
    var answer: DriverObject
    do {
        let result = try service.read(request: request, combined: combined, bind: {
            binds += 1
            var current = initial
            if binds > 1 {
                switch mode {
                case "moved": current["bounds"] = ["x": 1, "y": 2, "width": 120, "height": 80]
                case "reusedPid": current["processStart"] = "11.20"
                case "reowned": current["pid"] = 99
                case "closed": throw DriverFault("IDENTITY_CHANGED")
                case "retitled": current["title"] = "New title"
                default: break
                }
            }
            return current
        }, tree: {
            walks += 1
            if mode == "parallel" {
                guard fake.started.wait(timeout: .now() + request.remaining) == .success else { throw DriverFault("NOT_PARALLEL") }
                fake.treeStarted.signal()
            }
            if mode == "treeFailure" { throw DriverFault("AX_UNAVAILABLE") }
            var treeWindow = initial
            if mode == "wrongTree" { treeWindow["windowId"] = "72" }
            return ["window": treeWindow, "text": "Window: Fixture\n0 standard window Fixture",
                    "readId": 9, "truncated": mode == "truncated", "elapsedMs": 1.0]
        })
        answer = ["ok": true, "result": result]
        if options["decode"] as? Bool == true,
           let screenshot = result["screenshot"] as? DriverObject,
           let data = Data(base64Encoded: screenshot["data"] as! String),
           let source = CGImageSourceCreateWithData(data as CFData, nil),
           let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) {
            let w = decoded.width, h = decoded.height
            var pixels = [UInt8](repeating: 0, count: w * h * 4)
            let context = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(decoded, in: CGRect(x: 0, y: 0, width: w, height: h))
            // Bitmap rows start at the top; drawing coordinates start at the bottom.
            let a = ((3 * h / 4) * w + w / 4) * 4, b = ((h / 4) * w + 3 * w / 4) * 4
            answer["decoded"] = ["width": w, "height": h,
                "first": Array(pixels[a..<(a + 3)]), "last": Array(pixels[b..<(b + 3)])]
        }
    } catch let fault as DriverFault { answer = ["ok": false, "code": fault.code, "message": fault.message, "unhealthy": fault.unhealthy] }
    answer["binds"] = binds; answer["walks"] = walks; answer["captures"] = fake.captures
    answer["preflights"] = fake.preflights
    return answer
}
while let line = readLine() {
    do {
        let options = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! DriverObject
        var answer: DriverObject
        if let pixels = options["pixels"] as? [Int] {
            do { try DriverCaptureService.validatePixels(pixels[0], pixels[1]); answer = ["ok": true] }
            catch let fault as DriverFault { answer = ["ok": false, "code": fault.code] }
        } else if options["mode"] as? String == "lateCallback" {
            let slot = DriverCaptureSlot<Int>()
            do { _ = try slot.wait(DriverRequest([:], seconds: 0.01)) } catch {}
            slot.finish(.success(10)); slot.finish(.success(20))
            let next = DriverCaptureSlot<Int>(); next.finish(.success(30)); next.finish(.success(40))
            answer = ["ok": try next.wait(DriverRequest([:])) == 30]
        } else { answer = try run(options) }
        let bytes = try JSONSerialization.data(withJSONObject: answer, options: [.sortedKeys])
        print(String(data: bytes, encoding: .utf8)!)
    } catch { print("{\"ok\":false,\"code\":\"HARNESS_ERROR\"}") }
}
`;

test('capture uses a single-window API and never requests a grant', async () => {
  const source = await readFile(sourceURL, 'utf8');
  assert.match(source, /SCContentFilter\(desktopIndependentWindow: window\)/);
  assert.match(source, /CGPreflightScreenCaptureAccess\(\)/);
  assert.match(source, /onScreenWindowsOnly: false/);
  assert.match(source, /config\.includeChildWindows = false/);
  assert.match(source, /config\.showsCursor = false/);
  assert.doesNotMatch(source, /CGRequestScreenCaptureAccess|CGWindowListCreateImage|CGDisplayCreateImage|captureImage\(in:|NSWorkspace|NSWindow\(|NSPanel\(|\.activate\(|orderFront|CGEventPost/);
});

test('native capture with synthetic pixels and a fake backend', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-driver-capture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'capture.swift'), binary = join(root, 'capture');
  await writeFile(file, (await readFile(sourceURL, 'utf8')) + '\n' + harness);
  await promisify(execFile)('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc',
    '-module-cache-path', join(root, 'modules'), file, '-o', binary], { timeout: 240000, maxBuffer: 128000 });
  const cases = [];
  const check = (name, input, verify) => cases.push({ name, input, verify });
  const error = (name, input, code, step) => check(name, input, r => {
    assert.equal(r.ok, false); assert.equal(r.code, code);
    if (step) assert.equal(r.message, 'IDENTITY_CHANGED step=' + step);
  });
  check('UC2D region hashes use top-left geometry, clip edges and ignore pixels outside the patch', { mode: 'regionHashes' }, r => {
    assert.deepEqual(r, { ok: true, repeatEqual: true, targetChanged: true, outsideUnchanged: true, cornerChanged: true });
  });
  check('explicit registration installs both capture handlers', { mode: 'adapter' }, r => {
    assert.equal(r.ok, true);
    assert.deepEqual(r.methods, ['getAXStateAndScreenshot', 'getScreenshot']);
    assert.equal(r.result.text, 'fixture tree');
  });
  check('registered screenshot skips tree fields', { mode: 'adapter', combined: false }, r => {
    assert.equal(r.ok, true); assert.equal(r.result.text, undefined);
  });
  check('registered failure clears retained read map', { mode: 'adapterFailure' }, r => {
    assert.equal(r.code, 'CAPTURE_UNAVAILABLE'); assert.equal(r.maps, 0);
  });
  error('inventory fixtures cannot reach the live provider', { mode: 'adapterFixture' }, 'SCREEN_RECORDING_REQUIRED');
  for (const [mode, scale] of [['ok', 2], ['oneX', 1], ['fractional', 1.25]]) {
    check(`PNG dimensions, negative origin and ${scale}x geometry`, { mode }, r => {
      assert.equal(r.ok, true);
      assert.equal(r.binds, 2); assert.equal(r.walks, 1); assert.equal(r.captures, 1);
      const { geometry: g, capture, screenshot, text, readId } = r.result;
      assert.equal(g.scaleX, scale); assert.equal(g.scaleY, scale);
      assert.deepEqual(g.windowBounds, { x: -320, y: 41.5, width: 120, height: 80 });
      assert.equal(screenshot.mimeType, 'image/png');
      const png = Buffer.from(screenshot.data, 'base64');
      assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(png.readUInt32BE(16), g.pixelWidth); assert.equal(png.readUInt32BE(20), g.pixelHeight);
      assert.match(capture.note, /origin top-left; window-only, overlays excluded/);
      assert.match(capture.note, new RegExp(`${g.pixelWidth}x${g.pixelHeight} pixels`));
      assert.equal(capture.status, 'ok'); assert.match(text, /standard window/); assert.equal(readId, 9);
      assert.ok(Number.isFinite(r.result.elapsedMs));
    });
  }
  check('standalone screenshot skips AX walk', { combined: false }, r => {
    assert.equal(r.ok, true); assert.equal(r.walks, 0); assert.equal(r.result.text, undefined);
    assert.equal(r.result.geometry.scaleX, 2);
  });
  for (const combined of [false, true]) for (const format of ['png', 'jpeg']) for (const scale of ['pixel', 'point']) {
    const params = { windowId: '71', processStart: '10.20', format, scale };
    check(`${combined ? 'combined' : 'standalone'} ${format}/${scale} encodes the whole synthetic frame`, { combined, params, decode: true }, r => {
      assert.equal(r.ok, true);
      assert.equal(r.captures, 1); assert.equal(r.binds, 2); assert.equal(r.walks, combined ? 1 : 0);
      const { screenshot, geometry, capture } = r.result;
      assert.equal(screenshot.mimeType, `image/${format}`);
      const width = scale === 'point' ? 120 : 240, height = scale === 'point' ? 80 : 160;
      assert.deepEqual(imageSize(screenshot.data), { width, height });
      assert.equal(geometry.pixelWidth, width); assert.equal(geometry.pixelHeight, height);
      assert.equal(geometry.scaleX, scale === 'point' ? 1 : 2);
      assert.equal(geometry.scaleY, scale === 'point' ? 1 : 2);
      assert.deepEqual(geometry.windowBounds, { x: -320, y: 41.5, width: 120, height: 80 });
      assert.equal(r.decoded.width, width); assert.equal(r.decoded.height, height);
      // Interior samples tolerate JPEG loss but catch a flip or crop.
      assert.ok(r.decoded.first[0] > 230 && r.decoded.first[1] < 20 && r.decoded.first[2] < 20, JSON.stringify(r.decoded));
      assert.ok(r.decoded.last[0] < 20 && r.decoded.last[1] < 20 && r.decoded.last[2] > 230, JSON.stringify(r.decoded));
      const content = [{ type: 'text', text: capture.note }, { type: 'image', ...screenshot }];
      const frame = relay.screenshotFrame(content);
      assert.deepEqual(frame, geometry);
      assert.deepEqual(screenshotOf(content, { app: 'Fixture', title: 'Covered' }), ['Fixture', { width, height }, 'Covered']);
    });
  }
  for (const mode of ['oneX', 'fractional']) {
    check(`point scale normalizes ${mode} source pixels`, { mode, params: { windowId: '71', processStart: '10.20', scale: 'point' } }, r => {
      assert.equal(r.ok, true);
      assert.deepEqual(imageSize(r.result.screenshot.data), { width: 120, height: 80 });
      assert.equal(r.result.geometry.scaleX, 1);
    });
  }
  check('point dimensions round fractional bounds and report the actual per-axis ratio', {
    window: { bounds: { x: -10.5, y: 20.25, width: 119.75, height: 79.75 } },
    params: { windowId: '71', processStart: '10.20', scale: 'point' },
  }, r => {
    assert.equal(r.ok, true);
    assert.deepEqual(imageSize(r.result.screenshot.data), { width: 120, height: 80 });
    assert.equal(r.result.geometry.scaleX, 120 / 119.75);
    assert.equal(r.result.geometry.scaleY, 80 / 79.75);
  });
  for (const [key, values] of [['format', ['jpg', 'PNG', '', null, true, 1, {}]], ['scale', ['points', 'Pixel', '', null, false, 2, []]]]) {
    for (const value of values) check(`invalid ${key} ${JSON.stringify(value)} refuses before any host work`, {
      params: { windowId: '71', processStart: '10.20', [key]: value },
    }, r => {
      assert.equal(r.code, 'INVALID_PARAMS'); assert.equal(r.binds, 0); assert.equal(r.preflights, 0); assert.equal(r.captures, 0);
    });
  }
  for (const mode of ['badScale', 'hugeScale']) error(`point scaling cannot hide invalid source geometry: ${mode}`, {
    mode, params: { windowId: '71', processStart: '10.20', scale: 'point' },
  }, 'CAPTURE_SCALE_INVALID');
  check('capture and tree execute concurrently using a barrier', { mode: 'parallel' }, r => assert.equal(r.ok, true));
  check('partial AX tree stays explicitly truncated', { mode: 'truncated' }, r => assert.equal(r.result.truncated, true));
  check('a title change preserves identity', { mode: 'retitled' }, r => {
    assert.equal(r.ok, true); assert.equal(r.result.window.title, 'New title');
  });
  check('covered or off-display windows remain eligible', { window: { onScreen: false } }, r => assert.equal(r.ok, true));
  check('preflight denial does no capture or tree walk', { mode: 'denied' }, r => {
    assert.equal(r.code, 'SCREEN_RECORDING_REQUIRED'); assert.equal(r.captures, 0); assert.equal(r.walks, 0);
  });
  check('expired deadline does no provider or AX work', { mode: 'expired' }, r => {
    assert.equal(r.code, 'DEADLINE_EXCEEDED'); assert.equal(r.binds, 0); assert.equal(r.captures, 0);
    assert.equal(r.unhealthy, true);
  });
  check('capture deadline retires the helper', { mode: 'deadline' }, r => {
    assert.equal(r.code, 'DEADLINE_EXCEEDED'); assert.equal(r.unhealthy, true);
  });
  check('late and duplicate callbacks cannot affect another request', { mode: 'lateCallback' }, r => assert.equal(r.ok, true));
  for (const mode of ['moved', 'reusedPid', 'reowned', 'closed', 'wrongImageOwner', 'wrongTree']) {
    error(`identity refusal: ${mode}`, { mode }, 'IDENTITY_CHANGED',
      mode === 'closed' ? undefined : mode === 'wrongTree' ? 'capture-tree' : 'capture-target');
  }
  error('provider failure returns no partial success', { mode: 'failure' }, 'CAPTURE_UNAVAILABLE');
  error('tree failure returns no screenshot success', { mode: 'treeFailure' }, 'AX_UNAVAILABLE');
  for (const mode of ['badScale', 'hugeScale']) error(`scale refusal: ${mode}`, { mode }, 'CAPTURE_SCALE_INVALID');
  for (const window of [{ windowId: '0' }, { windowId: '071' }, { pid: true }, { processStart: '' },
    { identityVerified: false }, { minimized: true }, { bounds: { x: 0, y: 0, width: 0, height: 1 } },
    { bounds: { x: false, y: 0, width: 1, height: 1 } }]) {
    error(`invalid target ${JSON.stringify(window)}`, { window }, 'CAPTURE_TARGET_INVALID');
  }
  for (const params of [{}, { windowId: '71', processStart: '10.20', extra: true },
    { windowId: '71', processStart: '10.20', depth: true }, { windowId: '71', processStart: '10.20', depth: 65 },
    { windowId: '71', processStart: '10.20', budgetMs: 0 }]) {
    check(`invalid params ${JSON.stringify(params)}`, { params }, r => {
      assert.equal(r.code, 'INVALID_PARAMS'); assert.equal(r.captures, 0); assert.equal(r.binds, 0);
    });
  }
  error('screenshot refuses tree options', { combined: false, params: { windowId: '71', processStart: '10.20', depth: 1 } }, 'INVALID_PARAMS');
  for (const pixels of [[0, 1], [1, -1], [16385, 1], [4097, 4096], [16384, 16384]]) {
    error(`pixel allocation limit ${pixels}`, { pixels }, 'CAPTURE_SIZE_LIMIT');
  }
  check('16 megapixel boundary is allowed', { pixels: [4096, 4096] }, r => assert.equal(r.ok, true));
  const results = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/nice', ['-n', '20', binary], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject);
    child.once('close', code => {
      try {
        assert.equal(code, 0, stderr); assert.equal(stderr, '');
        resolve(stdout.trim().split('\n').map(line => JSON.parse(line)));
      } catch (e) { reject(e); }
    });
    child.stdin.end(cases.map(c => JSON.stringify(c.input)).join('\n') + '\n');
  });
  assert.equal(results.length, cases.length);
  for (const [i, c] of cases.entries()) await t.test(c.name, () => c.verify(results[i]));
});
