import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

// Real binding, keyboard and release registry with a fake layout and event sink.
// This entry point never starts an application or posts an OS event.
const entry = String.raw`
let nonce = String(repeating: "a", count: 64)
let frame: DriverObject = ["x": 0, "y": 0, "width": 100, "height": 100]
let fixture: DriverObject = ["apps": [["id": "test.fake", "name": "Fixture", "pid": 42, "processStart": "start"]],
  "windows": [["windowId": "7", "pid": 42, "processStart": "start", "app": "Fixture", "title": "Fixture", "bounds": frame,
    "onScreen": true, "layer": 0, "hidden": false]],
  "trees": ["7": ["AXRole": "AXWindow", "AXTitle": "Fixture", "AXMinimized": false, "AXFullScreen": false, "frame": frame, "children": []]]]
func run(_ mode: String) throws -> [DriverObject] {
  let decoded = try DriverJSON.decode(JSONSerialization.data(withJSONObject: fixture))
  let core = DriverCore(fixture: decoded), runtime = DriverRuntime(core: core, nonce: nonce)
  var events = [DriverObject](), guards = 0, next = 0, refusing = false
  func request(_ method: String, _ args: [Any]) throws -> DriverRequest {
    next += 1
    let params: DriverObject = method == "getAXState" ? ["windowId": "7", "processStart": "start"] :
      ["windowId": "7", "processStart": "start", "readId": 1, "args": args]
    return try DriverRequest(["protocol": driverProtocol, "platform": "darwin", "nonce": nonce, "id": next,
      "method": method, "params": params,
      "deadline": Int(Date().timeIntervalSince1970 * 1000) + 30000], nonce: nonce, previous: next - 1)
  }
  if mode.hasPrefix("stop-posted") {
    var rows = [DriverObject]()
    runtime.postReleaseEvent = { event, pid in
      rows.append(["type": event.type == .flagsChanged ? "flagsChanged" : "keyUp",
        "keyCode": Int(event.getIntegerValueField(.keyboardEventKeycode)), "flags": event.flags.rawValue, "pid": Int(pid)])
    }
    try runtime.releasePostedInput(["windowId": "7", "processStart": "start", "pid": 42,
      "holds": mode == "stop-posted-caps" ? [["key": 57]] : [["key": 55], ["key": 56], ["key": 0]]])
    return rows
  }
  let read = try request("getAXState", [])
  _ = try core.readTree(["windowId": "7", "processStart": "start"], request: read)
  let keyboard = DriverKeyboard(layout: { ["s": DriverKeyboardMapping(keyCode: 1, modifiers: [])] }, makeEvent: { spec in
    return { pid in
      var row = spec.json; row["pid"] = Int(pid); events.append(row)
      if mode == "stop-mid-chord" && events.count == 1 { _ = runtime.inputRelease.stop() }
    }
  }, ladder: { mode == "ordinary-key-events" ? "key-events" : "flags-changed" }, pause: {}, beforeInput: { _, _ in
    guards += 1
    if (mode.hasPrefix("ordinary") || refusing) && !events.isEmpty { throw DriverFault("PERSON_TOOK_OVER") }
  })
  keyboard.register(in: runtime) { $0 }
  if mode == "stop-surviving" {
    let down = try request("modifiers", [["keys": ["meta"], "state": "down"]])
    down.inputRelease = runtime.inputRelease
    _ = try keyboard.handle(down, core: core)
    events.removeAll(); refusing = true
    let next = try request("pressKey", ["shift+s"])
    next.inputRelease = runtime.inputRelease
    do { _ = try keyboard.handle(next, core: core) }
    catch let failure as DriverKeyboardFault { guard failure.code == "PERSON_TOOK_OVER" else { throw failure } }
    _ = runtime.inputRelease.stop(); try runtime.releaseHeldInput()
    return events
  }
  let held = mode == "stop-held"
  let action = try request(held ? "modifiers" : "pressKey", held ? [["keys": ["meta", "shift"], "state": "down"]] : ["cmd+s"])
  if mode.hasPrefix("stop") { action.inputRelease = runtime.inputRelease }
  do { _ = try keyboard.handle(action, core: core) }
  catch let error as DriverKeyboardFault {
    guard error.code == (mode.hasPrefix("ordinary") ? "PERSON_TOOK_OVER" : "USER_STOPPED") else { throw error }
  }
  if held { _ = runtime.inputRelease.stop(); try runtime.releaseHeldInput() }
  return events
}
while let mode = readLine() {
  do { print(String(data: try JSONSerialization.data(withJSONObject: run(mode)), encoding: .utf8)!) }
  catch { FileHandle.standardError.write(Data("fixture failure: \(error)\n".utf8)); exit(1) }
}
`;

test('ordinary cleanup preserves modifier types and Stop pairs flagsChanged with explicit key-up',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-stop-key-cleanup-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const original = macDriverSource();
    const anchor = 'out.append(release)';
    assert.ok(original.includes(anchor), 'missing cleanup mutation anchor');
    const source = original.replace(anchor,
      'if !(stop && release.type == "flagsChanged" && CommandLine.arguments.contains("--broken-stop")) { out.append(release) }')
      .replace('key.event.type == "flagsChanged" ? "flagsChanged" : "keyUp"',
        'key.event.type == "flagsChanged" && !CommandLine.arguments.contains("--broken-ordinary") ? "flagsChanged" : "keyUp"')
      .replace('57: 1 << 16, ', process.env.INT22D_MUTANT === 'd-release' ? '' : '57: 1 << 16, ')
      .replace('changed.type = .flagsChanged', 'changed.type = CommandLine.arguments.contains("--broken-posted") ? .keyUp : .flagsChanged');
    const at = source.lastIndexOf('\ndriverMain()');
    assert.notEqual(at, -1);
    const path = join(root, 'main.swift'), binary = join(root, 'fixture');
    await writeFile(path, source.slice(0, at) + '\n' + entry);
    const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), path, '-o', binary],
      { timeout: 240000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
    assert.equal(compile.status, 0, compile.stderr);
    t.diagnostic('binaryBytes=' + (await stat(binary)).size);
    const modes = ['ordinary', 'ordinary-key-events', 'stop-mid-chord', 'stop-held', 'stop-posted', 'stop-surviving', 'stop-posted-caps'];
    const run = (flags = []) => {
      const result = spawnSync(binary, flags, { input: modes.join('\n') + '\n',
        timeout: 10000, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 65536 });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim().split('\n').map(JSON.parse);
    };
    const verify = rows => {
      assert.deepEqual(rows[0].map(event => [event.type, event.keyCode, event.flags]),
        [['flagsChanged', 55, 1048576], ['flagsChanged', 55, 0]], 'ordinary cleanup must preserve flagsChanged');
      assert.deepEqual(rows[1].map(event => event.type), ['keyDown', 'keyUp']);
      const masks = { 55: 1048576, 56: 131072, 57: 65536 };
      for (const index of [2, 3, 4, 5, 6]) {
        const events = rows[index];
        assert.ok(events.length > 0);
        let pairs = 0;
        for (let at = index === 5 ? 2 : 0; at < events.length; at++) {
          const event = events[at], mask = masks[event.keyCode];
          if (event.type === 'flagsChanged' && mask && !(event.flags & mask)) {
            assert.deepEqual(events[at + 1], { ...event, type: 'keyUp' }, 'Stop flagsChanged must precede its explicit key-up');
            pairs++;
          }
        }
        assert.ok(pairs > 0, 'Stop flagsChanged release must be posted');
        assert.ok(events.every(event => event.pid === 42));
        assert.equal(events.at(-1).flags, 0);
      }
      assert.deepEqual(rows[4].map(event => [event.type, event.keyCode, event.flags]), [
        ['flagsChanged', 55, 131072], ['keyUp', 55, 131072],
        ['flagsChanged', 56, 0], ['keyUp', 56, 0], ['keyUp', 0, 0],
      ], 'posted releases preserve remaining modifiers and plain keys stay key-up');
      assert.deepEqual(rows[5].slice(0, 2).map(event => [event.type, event.keyCode, event.flags]), [
        ['flagsChanged', 56, 1179648], ['flagsChanged', 56, 1048576],
      ], 'ordinary refusal releases Shift while preserving inherited Command');
      assert.deepEqual(rows[6].map(event => [event.type, event.keyCode, event.flags]), [
        ['flagsChanged', 57, 0], ['keyUp', 57, 0],
      ], 'flagsChanged modifier codes include Caps Lock');
      assert.ok(rows[5].slice(2).length > 0);
      assert.ok(rows[5].slice(2).every(event => event.keyCode === 55), 'Stop keeps the surviving Command release callback');
    };
    const broken = process.env.INT22D_MUTANT;
    verify(run(broken === 'a-keyboard' ? ['--broken-stop'] : broken === 'a-posted' ? ['--broken-posted'] : []));
    await t.test('broken ordinary key-up cleanup is rejected', () => {
      assert.throws(() => verify(run(['--broken-ordinary'])), /ordinary cleanup must preserve/);
    });
    await t.test('broken posted modifier cleanup is rejected', () => {
      assert.throws(() => verify(run(['--broken-posted'])), /Stop flagsChanged/);
    });
    await t.test('broken Stop key-up-only cleanup is rejected', () => {
      assert.throws(() => verify(run(['--broken-stop'])), /Stop flagsChanged/);
    });
  });
