import test from 'node:test';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const nonce = 'a'.repeat(64);
const entry = String.raw`
let nonce = String(repeating: "a", count: 64)
let frame: DriverObject = ["x": 0, "y": 0, "width": 100, "height": 100]
let rawFixture: DriverObject = ["apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "1.2"]],
  "windows": [["windowId": "7", "pid": 42, "processStart": "1.2", "app": "Fixture", "title": "Fixture", "bounds": frame,
    "onScreen": true, "layer": 0, "hidden": false]],
  "trees": ["7": ["AXRole": "AXWindow", "AXTitle": "Fixture", "AXMinimized": false, "AXFullScreen": false, "frame": frame, "children": []]]]
let fixture = try! DriverJSON.decode(JSONSerialization.data(withJSONObject: rawFixture))
let core = DriverCore(fixture: fixture), runtime = DriverRuntime(core: core, nonce: nonce)
var emergency: [DriverObject] = []
runtime.postReleaseEvent = { event, pid in
  emergency.append(["type": event.type.rawValue, "key": event.getIntegerValueField(.keyboardEventKeycode), "pid": Int(pid)])
}
let releaseParams: DriverObject = ["windowId": "7", "processStart": "1.2", "pid": 42,
  "holds": [["button": 0, "x": 10.0, "y": 12.0], ["key": 55], ["key": 56]]]
try! runtime.releasePostedInput(releaseParams)
if emergency.count != 5 || emergency[0]["type"] as? UInt32 != CGEventType.leftMouseUp.rawValue ||
   emergency[1]["type"] as? UInt32 != CGEventType.flagsChanged.rawValue || emergency[2]["type"] as? UInt32 != CGEventType.keyUp.rawValue ||
   emergency[3]["type"] as? UInt32 != CGEventType.flagsChanged.rawValue || emergency[4]["type"] as? UInt32 != CGEventType.keyUp.rawValue {
  FileHandle.standardError.write(Data("release-events:\(emergency)\n".utf8)); _exit(89)
}
emergency.removeAll()
var changed = releaseParams; changed["processStart"] = "9.9"
do { try runtime.releasePostedInput(changed); _exit(90) } catch {}
if !emergency.isEmpty { _exit(91) }
// A failed release must not prevent attempts for the other held inputs.
var releaseAttempts = 0
runtime.postReleaseEvent = { _, _ in releaseAttempts += 1; if releaseAttempts == 1 { throw DriverFault("DRIVER_INTERNAL") } }
do { try runtime.releasePostedInput(releaseParams); _exit(92) } catch {}
if releaseAttempts != 5 { _exit(93) }
releaseAttempts = 0
runtime.postReleaseEvent = { _, _ in releaseAttempts += 1 }
var malformed = releaseParams
malformed["holds"] = [["button": 99, "x": 10.0, "y": 12.0], ["key": 55], ["key": 56]]
do { try runtime.releasePostedInput(malformed); _exit(94) } catch {}
if releaseAttempts != 4 { _exit(95) }
let stopState = DriverUserStop(), oldTicket = stopState.enqueue(100)
try! stopState.receive(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "control": "stop", "call": 100], nonce: nonce)
stopState.end(100)
try! stopState.receive(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "control": "prompt"], nonce: nonce)
var sticky = false
 do { try oldTicket.check() } catch let fault as DriverFault { sticky = fault.code == "USER_STOPPED" }
if !sticky { _exit(88) }
try! stopState.enqueue(101).check()
var events = [DriverObject]()
let keyboard = DriverKeyboard(layout: { ["a": DriverKeyboardMapping(keyCode: 0, modifiers: [])] }, makeEvent: { spec in
  return { pid in
    events.append(spec.json)
    if spec.type == "keyUp" && [55, 56].contains(spec.keyCode) { FileHandle.standardError.write(Data("released-key-\(spec.keyCode)\n".utf8)) }
    if spec.type == "keyDown" { FileHandle.standardError.write(Data("posted\n".utf8)) }
  }
}, pause: { Thread.sleep(forTimeInterval: 0.02) }, beforeInput: { _, _ in })
keyboard.register(in: runtime) { failure in
  var fault = DriverFault(failure.code, unhealthy: failure.unhealthy); fault.disposition = failure.json; return fault
}
runtime.register(method: "getAXState") { request, core in try core.readTree(request.params, request: request) }
runtime.register(method: "fixtureEvents") { _, _ in ["events": events] }
runtime.register(method: "drag") { request, _ in
  let window = DriverPointerWindow(pid: 42, windowID: 7, bounds: CGRect(x: 0, y: 0, width: 100, height: 100), json: [:])
  final class Prepared: DriverPointerPrepared {
    func post(_ index: Int) throws {
      events.append(["pointer": index]); if index == 1 { FileHandle.standardError.write(Data("posted\n".utf8)) }
    }
    func release(_ index: Int) throws { events.append(["release": index]); FileHandle.standardError.write(Data("released-button\n".utf8)) }
  }
  struct Sink: DriverPointerSink {
    func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { Prepared() }
  }
  let context = DriverPointerContext(window: window, geometry: nil, validateRead: {}, resolveElement: { _ in CGRect(x: 5, y: 5, width: 10, height: 10) },
    checkBeforePost: { try DriverPointer.fromCore { try request.check() } }, checkReleaseIdentity: {}, remaining: { request.remaining },
    wait: { seconds in
      if CommandLine.arguments.contains("--stalled") && events.last?["pointer"] as? Int == 1 { Thread.sleep(forTimeInterval: 2) }
      try DriverPointer.fromCore { try request.pause(seconds) }
    }, admitInput: { try request.admitInput() }, dispatch: { release, post in
      if let registry = request.inputRelease { try registry.post("pointer", release: release, post) } else { try post() }
    }, clearRelease: { request.inputRelease?.clear("pointer") })
  do { return try DriverPointer.perform(method: "drag", args: [1, 2], context: context, sink: Sink()) }
  catch let error as DriverPointerFault { var fault = DriverFault(error.code); fault.disposition = error.json; throw fault }
}
runtime.serve()
`;

test('real helper reader stops mid-text and held drag, releases modifiers, and latches input',
  { skip: process.platform !== 'darwin', timeout: 720000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-stop-native-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = macDriverSource()
      .replace('try stopCheck?()', 'if !(method == "typeText" && CommandLine.arguments.contains("--broken-mid-text")) { try stopCheck?() }')
      .replace('do { try releaseHeldInput() }', 'do { if !CommandLine.arguments.contains("--broken-modifiers") { try releaseHeldInput() } }')
      .replace('for release in holds.values {', 'for (lane, release) in holds { if CommandLine.arguments.contains("--broken-reader") || lane == "keyboard" && CommandLine.arguments.contains("--broken-reader-keys") { continue }')
      .replace('try identity(); try postReleaseEvent', 'if !CommandLine.arguments.contains("--broken-release-identity") { try identity() }; try postReleaseEvent')
      .replace('let window = try core.inventory.bound(binding)', 'let window = try core.inventory.bound(CommandLine.arguments.contains("--broken-release-identity") ? ["windowId": "7", "processStart": "1.2"] : binding)')
      .replace('try prepared.release(index)', 'if !CommandLine.arguments.contains("--broken-reader-button") { try prepared.release(index) }');
    const at = source.lastIndexOf('\ndriverMain()');
    const path = join(root, 'main.swift'), binary = join(root, 'fixture');
    await writeFile(path, source.slice(0, at) + '\n' + entry);
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), path, '-o', binary],
      { timeout: 600000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(built.status, 0, JSON.stringify({ error: built.error?.code, signal: built.signal, stderr: built.stderr }));
    async function scenario(flags = []) {
    const child = spawn(binary, flags, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', status;
    const replies = new Map(), waiters = new Map();
    const exit = new Promise(resolve => child.once('close', (code, signal) => {
      status = { code, signal };
      for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(Error('fixture exited ' + JSON.stringify(status) + ': ' + stderr)); }
      waiters.clear(); resolve(status);
    }));
    try {
    createInterface({ input: child.stdout }).on('line', line => {
      const reply = JSON.parse(line), waiter = waiters.get(reply.id);
      replies.set(reply.id, reply); waiters.delete(reply.id); clearTimeout(waiter?.timer); waiter?.resolve(reply);
    });
    let id = 0, current;
    const timings = [];
    child.stderr.on('data', bytes => { stderr += String(bytes); if (String(bytes).includes('posted') && current) { current(); current = undefined; } });
    const send = (method, params = {}, extra = {}) => {
      const call = ++id;
      const result = new Promise((resolve, reject) => {
        if (status) { reject(Error('fixture already exited ' + JSON.stringify(status) + ': ' + stderr)); return; }
        const timer = setTimeout(() => reject(Error('no fixture reply for ' + method + ': ' + stderr)), 5000);
        waiters.set(call, { resolve, reject, timer });
      });
      child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
        id: call, method, params, deadline: Date.now() + 10000, ...extra }) + '\n');
      return { call, result };
    };
    const control = (name, call) => child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
      control: name, ...call !== undefined ? { call } : {} }) + '\n');
    const binding = { windowId: '7', processStart: '1.2', readId: 1, read: 'none' };
    await send('getAXState', { windowId: '7', processStart: '1.2' }).result;
    assert.equal((await send('modifiers', { ...binding, args: [{ keys: ['meta'], state: 'down' }] }).result).ok, true);
    const early = await send('typeText', { ...binding, args: ['a'] }, { control: 'cancel-before-input' }).result;
    assert.equal(early.error.code, 'USER_STOPPED'); assert.equal(early.error.delivery, 'not-sent');
    const earlyEvents = (await send('fixtureEvents').result).result.events;
    assert.deepEqual(earlyEvents.map(event => event.type), ['flagsChanged', 'flagsChanged', 'keyUp']);
    assert.equal(earlyEvents.at(-1).flags, 0);
    control('prompt');
    for (const method of ['typeText', 'drag']) {
      let stoppedAt;
      const run = send(method, { ...binding, args: method === 'typeText' ? ['a'.repeat(80)] : [1, 2] });
      current = () => { stoppedAt = performance.now(); control('stop', run.call); };
      const reply = await run.result;
      assert.equal(reply.error?.code, 'USER_STOPPED', JSON.stringify(reply));
      assert.equal(reply.error.next, 'stop-tell-user');
      const elapsedMs = performance.now() - stoppedAt;
      timings.push({ method, elapsedMs });
      assert.ok(elapsedMs < 500, 'stop receipt within 500 ms');
      const logged = (await send('fixtureEvents').result).result.events;
      if (method === 'typeText') {
        assert.ok(logged.filter(row => row.type === 'keyDown').length < 80);
        assert.equal(logged.at(-1).type, 'keyUp');
      } else assert.ok('release' in logged.at(-1), 'held button released without another move');
      const refused = await send('typeText', { ...binding, args: ['a'] }).result;
      assert.equal(refused.error.code, 'USER_STOPPED');
      assert.equal(refused.error.delivery, 'not-sent');
      control('prompt');
    }
    const down = await send('modifiers', { ...binding, args: [{ keys: ['meta', 'shift'], state: 'down' }] }).result;
    assert.equal(down.ok, true);
    const run = send('drag', { ...binding, args: [1, 2] });
    let heldStopAt;
    current = () => { heldStopAt = performance.now(); control('stop', run.call); };
    assert.equal((await run.result).error.code, 'USER_STOPPED');
    timings.push({ method: 'held-modifier-drag', elapsedMs: performance.now() - heldStopAt });
    assert.ok(timings.at(-1).elapsedMs < 500, 'held-modifier stop receipt within 500 ms');
    const logged = (await send('fixtureEvents').result).result.events;
    assert.equal(logged.at(-1).type, 'keyUp');
    assert.equal(logged.at(-1).flags, 0, 'held modifier was not released');
    assert.deepEqual(logged.slice(-4).map(event => event.type), ['flagsChanged', 'keyUp', 'flagsChanged', 'keyUp']);
    assert.deepEqual(logged.slice(-4).filter(event => event.type === 'keyUp').map(event => event.keyCode).sort(), [55, 56], 'both retained modifiers released');
    child.stdin.end(); assert.equal((await exit).code, 0);
    return timings;
    } finally {
      child.stdin.end();
      const collect = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exit; clearTimeout(collect);
      for (const waiter of waiters.values()) clearTimeout(waiter.timer);
    }
    }
    const timings = await scenario();
    t.diagnostic('fake-provider stops: ' + JSON.stringify(timings));
    async function stalledRelease(flags = []) {
      const child = spawn(binary, ['--stalled', ...flags], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exit = new Promise(resolve => child.once('close', resolve));
      let stopped = false, stopAt, releaseAt, status, errorText = '';
      const receipts = [], replies = new Map(), waiters = new Map();
      createInterface({ input: child.stdout }).on('line', line => {
        const row = JSON.parse(line);
        if (row.control === 'released') { receipts.push(row); return; }
        replies.set(row.id, row); waiters.get(row.id)?.(row); waiters.delete(row.id);
      });
      child.stderr.on('data', bytes => {
        const text = String(bytes); errorText += text;
        if (text.includes('released-button')) releaseAt = performance.now();
        if (text.includes('posted') && !stopped) {
          stopped = true; stopAt = performance.now();
          child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce, control: 'stop', call: 3 }) + '\n');
        }
      });
      let id = 0;
      const send = (method, params) => {
        const call = ++id;
        const reply = new Promise(resolve => waiters.set(call, resolve));
        child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: call,
          method, params, deadline: Date.now() + 10000 }) + '\n');
        return reply;
      };
      const collect = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await send('getAXState', { windowId: '7', processStart: '1.2' });
        await send('modifiers', { windowId: '7', processStart: '1.2', readId: 1, read: 'none', args: [{ keys: ['meta', 'shift'], state: 'down' }] });
        void send('drag', { windowId: '7', processStart: '1.2', readId: 1, read: 'none', args: [1, 2] });
        const deadline = performance.now() + 800;
        while ((!receipts.length || !releaseAt) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(releaseAt !== undefined && releaseAt - stopAt < 500, 'stalled drag must post mouse-up before retirement');
        assert.equal(receipts[0]?.release, 'posted', 'reader must confirm release posting, including retained modifiers');
        assert.match(errorText, /released-key-55/); assert.match(errorText, /released-key-56/);
        assert.equal(replies.has(3), false, 'release must not wait for the stuck action queue');
        // This is an owned fake-provider child, with no OS events or windows.
        child.kill('SIGKILL'); await exit;
        return { fakeProviderReleaseMs: releaseAt - stopAt };
      } finally {
        clearTimeout(collect); child.stdin.end(); child.kill('SIGKILL'); await exit;
      }
    }
    t.diagnostic(JSON.stringify(await stalledRelease()));
    await assert.rejects(stalledRelease(['--broken-reader']), /mouse-up/);
    await assert.rejects(stalledRelease(['--broken-reader-button']), /mouse-up/);
    await assert.rejects(stalledRelease(['--broken-reader-keys']), /released-key/);
    await assert.rejects(scenario(['--broken-release-identity']), /fixture exited/);
    await assert.rejects(scenario(['--broken-mid-text']), /stop receipt within 500 ms|fixture exited.*70/);
    await assert.rejects(scenario(['--broken-modifiers']), /held modifier was not released|keyUp|fixture exited.*70/);
    t.diagnostic('baseline passed; all 6 native broken variants rejected');
  });
