import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { macDriverSource, macDriverBuildInfo } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { prepareMacInputRegistrar } from '../plugins/sleight/lib/mac-driver/input-registrar.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const fakeBackend = String.raw`
final class RT7FixtureCapture: DriverCaptureBackend {
    func preflight() -> Bool { ProcessInfo.processInfo.environment["RT7_FAKE_CAPTURE"] != "denied" }
    func capture(_ target: DriverCaptureTarget, request: DriverRequest) throws -> DriverCapturedImage {
        if ProcessInfo.processInfo.environment["RT7_FAKE_CAPTURE"] == "failure" { throw DriverFault("CAPTURE_UNAVAILABLE") }
        let w = Int(target.bounds.width * 2), h = Int(target.bounds.height * 2)
        let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 0.4, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return DriverCapturedImage(image: context.makeImage()!, target: target)
    }
}
`;

test('capture registration compiles against RT2 and returns one stdio reply per request',
  { skip: process.platform !== 'darwin', timeout: 720000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-driver-capture-core-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'fixture-driver.swift'), binary = join(root, 'fixture-driver');
    const fixture = join(root, 'fixture.json'), nonce = 'c'.repeat(64);
    // Only the test's staged source wires the capture extension. Production
    // DriverMain belongs to RT2. The injected backend draws memory pixels only.
    const original = await macDriverSource();
    const marker = 'DispatchQueue.global().async { runtime.serve() }';
    assert.equal(original.split(marker).length, 2);
    await writeFile(source, fakeBackend + original.replace(marker,
      'runtime.registerCapture(backend: RT7FixtureCapture())\n' +
      'if ProcessInfo.processInfo.environment["GLS4_CAPTURE_REGISTRAR"] == "1" { runtime.registerRuntimeInputs(captureBackend: RT7FixtureCapture()) }\n    ' + marker));
    const bounds = { x: -10, y: 20, width: 100, height: 80 };
    await writeFile(fixture, JSON.stringify({
      apps: [{ id: 'test.rt7', name: 'Fixture', pid: 42, processStart: '10.20' }],
      windows: [{ windowId: '71', pid: 42, processStart: '10.20', bundleId: 'test.rt7', app: 'Fixture', title: 'Fixture', bounds,
        onScreen: true, hidden: false, layer: 0 }],
      trees: { '71': { AXRole: 'AXWindow', AXTitle: 'Fixture', AXMinimized: false, AXFullScreen: false, frame: bounds,
        children: [{ AXRole: 'AXButton', AXTitle: 'Save', AXIdentifier: 'save', frame: bounds }] } },
    }));
    await promisify(execFile)('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary], { killSignal: 'SIGKILL', timeout: 600000, maxBuffer: 128000 });
    const binding = { windowId: '71', processStart: '10.20' };
    const run = (requests, mode = 'ok') => new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/nice', ['-n', '20', binary, '--fixture', fixture], {
        env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce, RT7_FAKE_CAPTURE: mode }, stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
      child.once('error', reject); child.stdin.on('error', () => {});
      child.once('close', code => {
        try {
          assert.equal(code, 0, stderr); assert.equal(stderr, '');
          const replies = stdout.trim().split('\n').map(JSON.parse);
          assert.equal(replies.length, requests.length);
          resolve(replies);
        } catch (error) { reject(error); }
      });
      child.stdin.end(requests.map(([method, params = {}], index) => JSON.stringify({
        protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: index + 1, method, params,
        deadline: Date.now() + 5000,
      })).join('\n') + '\n');
    });
    await t.test('combined reply contains full tree, geometry and PNG through the real core', async () => {
      const replies = await run([['ping'], ['getAXStateAndScreenshot', binding], ['resolveElement', { ...binding, readId: 1, target: 1 }]]);
      assert.ok(replies[0].result.methods.includes('getScreenshot'));
      assert.ok(replies[0].result.methods.includes('getAXStateAndScreenshot'));
      const result = replies[1].result;
      assert.equal(replies[1].ok, true); assert.equal(result.readId, 1); assert.equal(result.truncated, false);
      assert.match(result.text, /button Save, ID: save/); assert.equal(result.capture.status, 'ok');
      assert.equal(result.geometry.scaleX, 2); assert.equal(result.geometry.pixelWidth, 200);
      assert.equal(Buffer.from(result.screenshot.data, 'base64').readUInt32BE(20), 160);
      assert.equal(replies[2].result.element.number, 1);
    });
    await t.test('default parent reuse preserves combined captures through the production registrar and real client', async t => {
      const driver = createMacDriverClient({ platform: 'darwin', prepare: async () => ({ status: 'ready',
        build: macDriverBuildInfo(original).build, spawn: ({ nonce }) => spawn(binary, ['--fixture', fixture], {
          env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce, RT7_FAKE_CAPTURE: 'ok', GLS4_CAPTURE_REGISTRAR: '1' },
          stdio: ['pipe', 'pipe', 'pipe'] }) }) });
      t.after(() => driver.close());
      const safety = createMacSafety({ driver, inputRegistrar: await prepareMacInputRegistrar(driver, macDriverBuildInfo(original).build),
        lease: { acquire: () => 'lease', renew() {}, release() {}, close() {} },
        approve: () => true, policy: () => ({ allow: true }), targetParents: () => [1], ancestry: () => [{ pid: 999, path: '/fixture/host' }],
        permissions: { app() {}, page() {}, sitesLimited: () => false } });
      t.after(() => safety.close());
      const first = await safety.request('getApp', { selector: 'Fixture' });
      const combined = await safety.request('getAXStateAndScreenshot', { ...binding, format: 'png', scale: 'pixel' });
      assert.ok(combined.readId > first.readId); assert.equal(combined.truncated, false);
      assert.match(combined.text, /button Save, ID: save/); assert.equal(combined.screenshot.mimeType, 'image/png');
      assert.equal(combined.geometry.pixelWidth, 200);
    });
    await t.test('screenshot alone retains the existing read map', async () => {
      const replies = await run([['getAXState', binding], ['getScreenshot', binding], ['resolveElement', { ...binding, readId: 1, target: 1 }]]);
      assert.equal(replies[1].ok, true); assert.equal(replies[1].result.text, undefined);
      assert.equal(replies[2].ok, true);
    });
    await t.test('all four capture settings survive real request validation and the combined AX walk', async () => {
      const settings = ['png', 'jpeg'].flatMap(format => ['pixel', 'point'].map(scale => ({ format, scale })));
      const replies = await run(settings.map(options => ['getAXStateAndScreenshot', { ...binding, ...options, depth: 2, budgetMs: 400 }]));
      for (const [i, { format, scale }] of settings.entries()) {
        assert.equal(replies[i].ok, true);
        const result = replies[i].result;
        assert.match(result.text, /button Save/);
        assert.equal(result.screenshot.mimeType, `image/${format}`);
        assert.equal(result.geometry.pixelWidth, scale === 'point' ? 100 : 200);
        assert.equal(result.geometry.pixelHeight, scale === 'point' ? 80 : 160);
        assert.equal(result.geometry.scaleX, scale === 'point' ? 1 : 2);
      }
    });
    for (const [mode, code] of [['denied', 'SCREEN_RECORDING_REQUIRED'], ['failure', 'CAPTURE_UNAVAILABLE']]) {
      await t.test(`${mode} clears the core's previous map`, async () => {
        const replies = await run([['getAXState', binding], ['getAXStateAndScreenshot', binding],
          ['resolveElement', { ...binding, readId: 1, target: 1 }]], mode);
        assert.equal(replies[1].ok, false); assert.equal(replies[1].error.code, code);
        assert.equal(replies[2].error.code, 'STALE_READ');
      });
    }
    await t.test('wrong process-start binding refuses without capture', async () => {
      const replies = await run([['getScreenshot', { ...binding, processStart: 'different' }]]);
      assert.equal(replies[0].ok, false); assert.equal(replies[0].error.code, 'IDENTITY_CHANGED');
    });
  });
