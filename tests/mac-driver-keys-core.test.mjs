import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';

// Real RT2 envelope decoder, binding and retained maps, fake inventory and sink.
// Keyboard faults are encoded here because RT2's DriverFault still needs its
// documented action-disposition adapter. Production registration stays explicit.
const entry = String.raw`
let nonce = String(repeating: "a", count: 64)
let fixture = try! DriverJSON.decode(Data(readLine()!.utf8))
let core = DriverCore(fixture: fixture)
var events = [DriverObject]()
let keyboard = DriverKeyboard(layout: { ["s": DriverKeyboardMapping(keyCode: 1, modifiers: [])] }, makeEvent: { spec in
    return { pid in var row = spec.json; row["pid"] = Int(pid); events.append(row) }
}, pause: {}, beforeInput: { _, _ in
    if fixture["refuseFlagsAfterDown"] as? Bool == true, !events.isEmpty {
        throw DriverFault("PERSON_HOLDS_MODIFIER")
    }
})
var previous = 0
while let line = readLine() {
    var out: DriverObject
    events = []
    do {
        let request = try DriverRequest(DriverJSON.decode(Data(line.utf8)), nonce: nonce, previous: previous)
        previous = request.id
        try request.check()
        let result = request.method == "getAXState" ? try core.readTree(request.params, request: request) : try keyboard.handle(request, core: core)
        out = ["ok": true, "result": result]
    } catch let error as DriverKeyboardFault { out = ["ok": false, "error": error.json] }
    catch let error as DriverFault { out = ["ok": false, "error": error.json] }
    catch { out = ["ok": false, "error": ["code": "INVALID_JSON"]] }
    out["events"] = events
    print(String(data: try! JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
}
`;
const frame = { x: 0, y: 0, width: 100, height: 100 };
const fixture = {
  apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: 'start' }],
  windows: [{ windowId: '7', pid: 42, processStart: 'start', app: 'Fixture', title: 'Untitled', bounds: frame,
    onScreen: true, layer: 0, hidden: false }],
  trees: { 7: { AXRole: 'AXWindow', AXTitle: 'Untitled', AXMinimized: false, AXFullScreen: false, frame, children: [] } },
};
const binding = { windowId: '7', processStart: 'start' };
const envelope = (id, method, params) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'a'.repeat(64), id, method, params, deadline: Date.now() + 30000 });

test('keyboard uses the real core binding and read map without desktop access', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-keyboard-core-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'keyboard-core.swift'), binary = join(root, 'keyboard-core');
  // Replace only the test process's entry point. No tracked RT2 source is edited.
  let composed = await macDriverSource();
  if (process.env.UC2C_KEY_CLEANUP_MUTATION) {
    assert.equal(process.env.UC2C_KEY_CLEANUP_MUTATION, 'flag');
    const from = 'for release in cleanup { do { try release(pid);';
    assert.equal(composed.split(from).length, 2);
    composed = composed.replace(from, 'for release in cleanup { do { try beforeInput(request, core); try release(pid);');
  }
  const at = composed.lastIndexOf('\ndriverMain()');
  assert.notEqual(at, -1);
  await writeFile(source, composed.slice(0, at) + '\n' + entry);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { killSignal: 'SIGKILL', encoding: 'utf8', timeout: 240000, maxBuffer: 65536 });
  assert.equal(compile.status, 0, JSON.stringify({ error: compile.error?.code, signal: compile.signal, stderr: compile.stderr }));
  t.diagnostic(`coreBinaryBytes=${(await stat(binary)).size}`);
  const rows = [
    envelope(1, 'pressKey', { ...binding, readId: 1, args: ['super+s'] }),
    envelope(2, 'getAXState', binding),
    envelope(3, 'pressKey', { ...binding, readId: 1, args: ['super+s'] }),
    envelope(4, 'getAXState', binding),
    envelope(5, 'pressKey', { ...binding, readId: 1, args: ['super+s'] }),
    envelope(6, 'typeText', { ...binding, processStart: 'recycled', readId: 2, args: ['s'] }),
    envelope(7, 'typeText', { ...binding, readId: true, args: ['s'] }),
    envelope(8, 'pressKey', { ...binding, readId: 2, args: ['super+s'] }),
    envelope(9, 'pressKey', { ...binding, readId: 2, args: ['z'] }),
    envelope(10, 'modifiers', { ...binding, readId: 2, args: [{ keys: ['meta'], state: 'down' }] }),
    envelope(11, 'typeText', { ...binding, readId: 2, args: ['s'] }),
    envelope(12, 'pressKey', { ...binding, processStart: 'recycled', readId: 2, args: ['s'] }),
    envelope(13, 'modifiers', { ...binding, readId: 2, args: [{ keys: ['meta'], state: 'up' }] }),
  ];
  const result = spawnSync(binary, [], { input: [fixture, ...rows].map(JSON.stringify).join('\n') + '\n', killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const replies = result.stdout.trim().split('\n').map(JSON.parse);
  await t.test('input needs a real retained read and uses only the bound PID', () => {
    assert.equal(replies[0].error.code, 'STALE_READ'); assert.equal(replies[0].events.length, 0);
    assert.equal(replies[1].result.readId, 1); assert.equal(replies[2].result.delivery, 'sent-unverified');
    assert.deepEqual(replies[2].events.map(e => [e.type, e.keyCode, e.pid]), [['flagsChanged', 55, 42], ['keyDown', 1, 42], ['keyUp', 1, 42], ['flagsChanged', 55, 42]]);
  });
  await t.test('key cleanup bypasses the flag refusal that stops a new press', () => {
    const guarded = spawnSync(binary, [], {
      input: [{ ...fixture, refuseFlagsAfterDown: true },
        envelope(1, 'getAXState', binding),
        envelope(2, 'pressKey', { ...binding, readId: 1, args: ['s'] }),
      ].map(JSON.stringify).join('\n') + '\n',
      killSignal: 'SIGKILL', encoding: 'utf8', timeout: 15000,
    });
    assert.equal(guarded.status, 0, guarded.stderr);
    const reply = guarded.stdout.trim().split('\n').map(JSON.parse)[1];
    assert.equal(reply.ok, false); assert.equal(reply.error.code, 'PERSON_HOLDS_MODIFIER');
    assert.deepEqual(reply.events.map(e => [e.type, e.keyCode, e.pid]), [['keyDown', 1, 42], ['keyUp', 1, 42]]);
  });
  await t.test('a newer read invalidates old keyboard input', () => {
    assert.equal(replies[3].result.readId, 2); assert.equal(replies[4].error.code, 'STALE_READ'); assert.equal(replies[4].events.length, 0);
  });
  await t.test('process-start and boolean read-id refusals happen before sending', () => {
    assert.equal(replies[5].error.code, 'IDENTITY_CHANGED'); assert.equal(replies[6].error.code, 'INVALID_PARAMS');
    assert.equal(replies[5].events.length + replies[6].events.length, 0); assert.equal(replies[7].ok, true);
  });
  await t.test('keyboard-internal failures retain their codes with the real closed DriverFault table', () => {
    for (const [index, code] of [[8, 'KEY_UNMAPPABLE'], [10, 'MODIFIERS_HELD'], [11, 'MODIFIER_BINDING_CHANGED']]) {
      assert.equal(replies[index].error.code, code);
      assert.equal(replies[index].error.delivery, 'not-sent');
      assert.equal(replies[index].events.length, 0);
    }
    assert.equal(replies[9].ok, true); assert.equal(replies[12].ok, true);
  });
});
