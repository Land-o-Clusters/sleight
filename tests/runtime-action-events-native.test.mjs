import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { createRuntimeHand } from '../plugins/sleight/lib/hand/runtime-hand.mjs';
import { createCursorEvents } from '../plugins/sleight/lib/hand/events.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

// Only fake inventory, keyboard closures and pointer sinks run. The production
// entry point is replaced by an stdin-only fixture; no CGEvent is posted.
const additions = String.raw`
    final class RecordingPointer: DriverPointerSink, DriverPointerPrepared {
        func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
        func post(_ index: Int) throws {}
        func release(_ index: Int) throws {}
    }
    let sink = RecordingPointer()
    for method in DriverPointer.methods {
        runtime.registerAction(method: method, handler: { request, core in
            do {
                let c = try DriverPointer.context(request: request, core: core, geometry: nil, checkPerson: {})
                let fast = DriverPointerContext(window: c.window, geometry: c.geometry, validateRead: c.validateRead,
                    resolveElement: c.resolveElement, checkBeforePost: c.checkBeforePost,
                    checkReleaseIdentity: c.checkReleaseIdentity, remaining: c.remaining, wait: { _ in },
                    admitInput: c.admitInput, actionPlan: c.actionPlan)
                return try DriverPointer.perform(method: request.method, args: request.params["args"] as! [Any], context: fast, sink: sink)
            } catch let error as DriverPointerFault {
                var fault = DriverFault(error.code, error.message, unhealthy: error.unhealthy)
                fault.disposition = error.json.filter { !["code", "message", "unhealthy"].contains($0.key) }; throw fault
            }
        })
    }
    let keyboard = DriverKeyboard(layout: { [:] }, makeEvent: { _ in { _ in } }, pause: {}, beforeInput: { _, _ in })
    keyboard.register(in: runtime, fault: { error in
        var fault = DriverFault(error.code, error.json["message"] as? String, unhealthy: error.unhealthy)
        fault.disposition = error.json.filter { !["code", "message", "unhealthy"].contains($0.key) }; return fault
    })
    runtime.register(method: "settle") { _, _ in ["settled": true, "quietBasis": "digest", "reason": "quiet"] }
`;
const nonce = 'a'.repeat(64);
const binding = { windowId: '7', processStart: 'start' };
const frame = { x: -220, y: 100, width: 400, height: 300 };
const inventory = {
  apps: [{ id: 'test.fake', name: 'PRIVATE-APP', pid: 321, processStart: 'start' }],
  windows: [{ ...binding, app: 'PRIVATE-APP', title: 'PRIVATE-TITLE', pid: 321, bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'PRIVATE-TITLE', AXMinimized: false, AXFullScreen: false, frame, children: [
    { AXRole: 'AXButton', AXTitle: 'PRIVATE-LABEL', AXIdentifier: 'button', frame: { x: -200, y: 120, width: 40, height: 20 } },
    { AXRole: 'AXTextField', AXSubrole: 'AXSecureTextField', AXValue: 'PRIVATE-VALUE',
      forbidReads: ['AXValue', 'AXTitle', 'AXDescription', 'AXIdentifier', 'AXHelp', 'AXURL'],
      frame: { x: -100, y: 200, width: 40, height: 20 } },
  ] } },
};

test('compiled runtime emits click, text, key, drag and refusal events with fakes only',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-runtime-events-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'driver.swift'), binary = join(root, 'driver'), fixture = join(root, 'fixture.json');
    await writeFile(fixture, JSON.stringify(inventory));
    // No real-app argument is reachable in this fixture, even if invoked incorrectly.
    let composed = macDriverSource()
      .replace('let core = DriverCore(fixture: fixture), runtime', 'guard fixture != nil else { _exit(64) }\n    let core = DriverCore(fixture: fixture), runtime')
      .replace('runtime.install(driverRegistrars)', additions);
    const at = composed.lastIndexOf('\ndriverMain()');
    assert.notEqual(at, -1);
    composed = composed.slice(0, at) + String.raw`
if CommandLine.arguments.dropFirst().first == "--event-backpressure-selftest" {
    let pipe = DriverActionPipe(descriptor: 3, nonce: String(repeating: "a", count: 64))
    let began = ProcessInfo.processInfo.systemUptime
    for id in 1...20000 {
        let state = DriverActionState(id: id, method: "typeText", args: ["PRIVATE-TYPED-VALUE"], pipe: pipe)
        state.admit(); state.finish(result: ["delivery": "sent-unverified"], error: nil, admitted: true)
    }
    let data = try! JSONSerialization.data(withJSONObject: ["actions": 20000, "elapsedMs": (ProcessInfo.processInfo.systemUptime - began) * 1000])
    print(String(decoding: data, as: UTF8.self))
} else if CommandLine.arguments.dropFirst().first == "--event-disabled-selftest" {
    let request = try! DriverRequest(["protocol": driverProtocol, "platform": "darwin",
        "nonce": String(repeating: "a", count: 64), "id": 1, "method": "click", "params": ["args": [1]],
        "deadline": Int(Date().timeIntervalSince1970 * 1000) + 5000], nonce: String(repeating: "a", count: 64), previous: 0)
    print(request.actionEvent == nil ? "disabled" : "enabled")
} else { driverMain() }
`;
    await writeFile(source, composed);
    const compile = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary], { encoding: 'utf8', timeout: 240000, killSignal: 'SIGKILL', maxBuffer: 65536 });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    t.diagnostic(`fixtureBinaryBytes=${(await stat(binary)).size}`);
    const requests = [
      ['getAXState', binding],
      ['click', { ...binding, readId: 1, args: [1], read: 'full' }],
      ['typeText', { ...binding, readId: 2, args: ['PRIVATE-TYPED-VALUE'] }],
      ['pressKey', { ...binding, readId: 2, args: ['Return'] }],
      ['drag', { ...binding, readId: 2, args: [1, 2] }],
      ['click', { ...binding, readId: 999, args: [1] }],
      ['getAXState', binding],
    ];
    const child = spawn(binary, ['--fixture', fixture], { env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce, SLEIGHT_DRIVER_EVENTS: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const raw = [], out = [], receipts = [];
    const feed = createRuntimeActionEvents();
    const cursor = createCursorEvents({ env: {}, platform: 'darwin', setting: () => ({ stream: true, labels: 'title' }),
      sink: { write: row => out.push(row), close() {} }, repeat: () => ({ unref() {} }), cancelRepeat() {} });
    t.after(() => { feed.close(); cursor.close(); });
    feed.connect(createRuntimeHand({ events: cursor, onReceipt: row => receipts.push(row) }));
    const wire = feed.wire({ nonce, stream: child.stdio[3] });
    let stdout = '', stderr = '';
    child.stdio[3].on('data', bytes => raw.push(bytes.toString()));
    child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
    for (const [index, [method, params]] of requests.entries()) {
      wire.begin(index + 1, method, params);
      child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: index + 1,
        method, params, deadline: Date.now() + 30000 }) + '\n');
    }
    child.stdin.end();
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); assert.equal(stderr, '');
    for (let n = 0; n < 32; n++) await new Promise(resolve => setImmediate(resolve));
    const replies = stdout.trim().split('\n').map(JSON.parse);
    assert.equal(replies.length, 7); assert.equal(replies[5].error.code, 'STALE_READ');
    const native = raw.join('').trim().split('\n').map(JSON.parse);
    assert.deepEqual(native.map(row => [row.id, row.phase, row.kind]), [
      [2, 'act', 'click'], [2, 'done', 'click'], [3, 'act', 'key'], [3, 'done', 'key'],
      [4, 'act', 'key'], [4, 'done', 'key'], [5, 'act', 'drag'], [5, 'done', 'drag'], [6, 'failed', 'click'],
    ]);
    assert.deepEqual(native[0].rect, [-200, 120, 40, 20]); assert.deepEqual(native[0].point, [-180, 130]);
    assert.deepEqual(native[1].outcome, { delivery: 'sent-unverified', settled: true, basis: 'digest' });
    const drag = native.find(row => row.id === 5 && row.phase === 'act');
    assert.equal(drag.path.length, 29); assert.deepEqual(drag.path[0], [-180, 130]); assert.deepEqual(drag.path.at(-1), [-80, 210]);
    assert.deepEqual(native.at(-1).outcome, { delivery: 'not-sent', settled: false, basis: 'none' });
    assert.doesNotMatch(JSON.stringify([native, out, receipts]), /PRIVATE-/);
    assert.equal(out.filter(row => row.phase === 'act').length, 4); assert.equal(receipts.length, 5);

    await t.test('no event channel means no native action-event state', () => {
      const env = { ...process.env }; delete env.SLEIGHT_DRIVER_EVENTS;
      const disabled = spawnSync(binary, ['--event-disabled-selftest'], { env, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
      assert.equal(disabled.status, 0, disabled.stderr);
      assert.equal(disabled.stdout.trim(), 'disabled');
    });

    await t.test('a disconnected side-channel cannot fail fake actions', async () => {
      const disconnected = spawn(binary, ['--fixture', fixture], { env: { ...process.env, SLEIGHT_DRIVER_NONCE: nonce, SLEIGHT_DRIVER_EVENTS: '1' },
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      disconnected.stdio[3].destroy();
      let output = ''; disconnected.stdout.on('data', bytes => { output += bytes; }); disconnected.stderr.resume();
      const rows = [['getAXState', binding], ['click', { ...binding, readId: 1, args: [1] }]];
      disconnected.stdin.end(rows.map(([method, params], index) => JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
        id: index + 1, method, params, deadline: Date.now() + 5000 })).join('\n') + '\n');
      const [status] = await once(disconnected, 'close'); assert.equal(status, 0);
      assert.equal(JSON.parse(output.trim().split('\n')[1]).result.delivery, 'sent-unverified');
    });
    await t.test('source has no desktop reads in its event projection', async () => {
      const eventSource = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverActionEvents.swift', import.meta.url), 'utf8');
      assert.doesNotMatch(eventSource, /AXUIElement|attributes\(|Thread\.sleep|\.wait\(|NSWindow|CGEvent\(/);
    });
    await t.test('an unread native event pipe cannot hold up 20000 fake actions', async () => {
      const stalled = spawn(binary, ['--event-backpressure-selftest'], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      let output = ''; stalled.stdout.on('data', bytes => { output += bytes; }); stalled.stderr.resume();
      // Deliberately never subscribe to or read fd 3.
      const [status] = await once(stalled, 'close'); assert.equal(status, 0);
      const measurement = JSON.parse(output); assert.equal(measurement.actions, 20000);
      t.diagnostic(JSON.stringify({ stalledNativePipe: measurement }));
    });
  });

test('an open event channel stays enabled while a writer holds its lock',
  { skip: process.platform !== 'darwin', timeout: 135000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-event-pipe-lock-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const eventSource = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverActionEvents.swift', import.meta.url), 'utf8');
    const end = eventSource.indexOf('final class DriverActionState');
    assert.ok(end > 0);
    const source = join(root, 'pipe.swift'), binary = join(root, 'pipe');
    // Compile the production pipe in isolation. The lock holder exists only in
    // this drawing-free fixture, in the same Swift file as the private lock.
    await writeFile(source, eventSource.slice(0, end) + String.raw`
typealias DriverObject = [String: Any]
extension DriverActionPipe {
    func holdingLock(_ body: () -> Void) { lock.lock(); defer { lock.unlock() }; body() }
}
let pipe = DriverActionPipe(descriptor: 3, nonce: String(repeating: "a", count: 64))
let held = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
DispatchQueue.global().async {
    pipe.holdingLock { held.signal(); release.wait() }
}
held.wait()
DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { release.signal() }
print(pipe.enabled ? "enabled" : "disabled")
`);
    const compile = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary],
    { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 120000, maxBuffer: 65536 });
    assert.equal(compile.status, 0, compile.stderr || String(compile.error));
    t.diagnostic(`pipeFixtureBinaryBytes=${(await stat(binary)).size}`);
    const contended = spawnSync(binary, [], { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], killSignal: 'SIGKILL', encoding: 'utf8', timeout: 5000 });
    assert.equal(contended.status, 0, contended.stderr);
    assert.equal(contended.stdout.trim(), 'enabled');
  });
