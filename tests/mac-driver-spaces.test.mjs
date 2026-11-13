import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { MAC_WINDOW_NOTICES, MAC_WINDOW_REFUSALS } from '../plugins/sleight/lib/mac-safety.mjs';
import { nativeLocal, nativeToolsSkip, localSpaceFixture, prepareNativeToolsFixture } from './fixtures/mac-driver-tools.mjs';

test('local real click uses the leased window among siblings and refuses mismatched bindings', { skip: nativeToolsSkip }, () => {
  prepareNativeToolsFixture();
  const data = localSpaceFixture();
  const identity = { ...data.windows[0], identityVerified: true };
  const args = { driverIdentity: identity, lease: { path: '/fixture/lease', token: 'owned' } };
  const lease = { token: 'owned', expires: Date.now() + 30000,
    window: { appId: identity.bundleId, title: identity.title, windowNumber: 7, url: null } };
  const sibling = { ...data.windows[0], windowId: '8', title: 'Sibling',
    bounds: { x: 400, y: 0, width: 200, height: 200 } };
  data.windows.unshift(sibling);
  const send = (inventory = data, request = args, patch = {}) => nativeLocal('real-click', request,
    { spaceInventory: inventory, clickPID: 42, lease, ...patch });
  const admitted = send();
  assert.equal(admitted.result.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.events.filter(e => e[0] === 'post').length, 2);
  const keyed = send(data, args, { lease: { ...lease,
    window: { appId: identity.bundleId, title: JSON.stringify(['7', 42, 'fixture-start']), url: null } } });
  assert.equal(keyed.result.ok, true, JSON.stringify(keyed));
  assert.equal(keyed.events.filter(e => e[0] === 'post').length, 2);
  for (const patch of [
    f => { f.windows[1].onScreen = false; },
    f => { f.windows = [f.windows[0]]; },
    f => { f.windows[1].processStart = 'replaced'; },
    f => { f.windows[1].pid = 43; },
    f => { delete f.trees[7]; },
    f => { f.trees[7].AXWindowNumber = 8; f.axWindows = [f.trees[7]]; },
    f => { f.trees[7].AXMinimized = true; },
    f => { f.trees[7].AXFullScreen = null; },
    f => { f.windowSnapshots = [f.windows, [f.windows[0], { ...f.windows[1], onScreen: false }]]; },
  ]) {
    const invalid = structuredClone(data); patch(invalid);
    const refused = send(invalid);
    assert.equal(refused.result.ok, false, JSON.stringify(refused));
    assert.equal(refused.events.filter(e => ['post', 'restore'].includes(e[0])).length, 0);
  }
  for (const request of [{}, { ...args, driverIdentity: { ...identity, processStart: 'old' } },
    { ...args, driverIdentity: { ...identity, pid: 43 } }, { ...args, driverIdentity: { ...identity, windowId: '8' } },
    { ...args, driverIdentity: { ...identity, identityVerified: false } },
    { ...args, driverIdentity: { ...identity, bundleId: 'org.test.other' } },
    { ...args, driverIdentity: { ...identity, title: 'Other' } }, { ...args, lease: undefined }]) {
    const refused = send(localSpaceFixture(), request);
    assert.equal(refused.result.ok, false, JSON.stringify(refused));
    assert.equal(refused.events.filter(e => ['post', 'restore'].includes(e[0])).length, 0);
  }
  for (const patch of [{ clickPID: 0 }, { idle: [20, 0] }, { idle: [20, 20, 0] },
    { lease: { ...lease, expires: 0 } }, { lease: { ...lease, token: 'other' } },
    { lease: { ...lease, window: { ...lease.window, windowNumber: 8 } } },
    { lease: { ...lease, window: { ...lease.window, url: 'https://example.test/' } } }]) {
    const refused = send(localSpaceFixture(), args, patch);
    assert.equal(refused.result.ok, false, JSON.stringify(refused));
    assert.equal(refused.events.filter(e => ['post', 'restore'].includes(e[0])).length, 0);
  }
});

test('local real click refuses a missing lease window before posting into a visible app', { skip: nativeToolsSkip }, () => {
  prepareNativeToolsFixture();
  const data = localSpaceFixture();
  const row = nativeLocal('real-click', { driverIdentity: { ...data.windows[0], identityVerified: true },
    lease: { path: '/fixture/lease', token: 'owned' } }, { spaceInventory: data, clickPID: 42,
    lease: { token: 'owned', expires: Date.now() + 30000, window: { appId: data.windows[0].bundleId } } });
  assert.equal(row.result.ok, false, JSON.stringify(row));
  assert.equal(row.events.filter(e => ['post', 'restore'].includes(e[0])).length, 0);
});

const nonce = 'a'.repeat(64);
const binding = { windowId: '7', processStart: '1.2' };
const window = { ...binding, pid: 42, bundleId: 'test.fake', app: 'Fixture', title: 'Document',
  bounds: { x: 0, y: 0, width: 100, height: 100 }, onScreen: true, layer: 0, hidden: false };
const tree = { AXRole: 'AXWindow', AXTitle: 'Document', AXMinimized: false, AXFullScreen: false,
  frame: window.bounds, pid: 42, AXWindowNumber: 7, actions: ['AXShowMenu'] };
const fixture = (state = {}, attributes = {}) => ({
  apps: [{ id: window.bundleId, name: 'Fixture', pid: 42, processStart: '1.2' }],
  displays: [window.bounds],
  windows: [{ ...window, ...state }], trees: { '7': { ...tree, ...attributes } },
});
const run = (command, args, input = '', env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  child.stdin.on('error', () => {}); child.stdin.end(input);
});

test('Space admission uses native CG/AX identity with a fake input sink only',
  { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
    const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-spaces-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = join(root, 'driver.swift'), binary = join(root, 'driver'), dataFile = join(root, 'fixture.json');
    const registration = `
      var fakeInputs = 0
      var fakeSelection = [0, 0]
      var access = DriverSemanticAccess.system
      access.isSettable = { _, _, _ in true }
      access.attributes = { node, names, request in
        var attrs = try node.attributes(names, request: request)
        if names.contains(kAXValueAttribute) { attrs[kAXValueAttribute] = "fixture" }
        if names.contains(kAXSelectedTextRangeAttribute) { attrs[kAXSelectedTextRangeAttribute] = fakeSelection }
        return attrs
      }
      access.set = { _, name, value, _ in
        fakeInputs += 1
        if name == kAXSelectedTextRangeAttribute { fakeSelection = value as! [Int] }
      }
      access.actionNames = { node, request in try node.secondaryActions(request).map { $0.action } }
      access.perform = { _, _, _ in fakeInputs += 1 }
      let semantic = DriverSemantic(access: access,
        beforeInput: { request, core in try core.checkPerson(request) })
      semantic.register(in: runtime)
      var keyPosts = 0
      let keyboard = DriverKeyboard(layout: { ["x": DriverKeyboardMapping(keyCode: 7, modifiers: [])] }, makeEvent: { _ in { _ in keyPosts += 1 } },
        pause: {}, beforeInput: { request, core in try core.checkPerson(request) })
      keyboard.register(in: runtime, fault: { failure in
        var fault = DriverFault(failure.code, unhealthy: failure.unhealthy)
        fault.disposition = failure.json; return fault
      })
      final class SpacePointerSink: DriverPointerSink, DriverPointerPrepared {
        var posts = 0
        func prepare(_ steps: [DriverPointerStep], window: DriverPointerWindow) throws -> DriverPointerPrepared { self }
        func post(_ index: Int) throws { posts += 1 }
        func release(_ index: Int) throws { posts += 1 }
      }
      let pointer = SpacePointerSink()
      for method in ["click", "doubleClick", "rightClick", "scroll", "drag"] {
        runtime.registerAction(method: method, handler: { request, core in
          do {
            let context = try DriverPointer.context(request: request, core: core, geometry: nil,
              checkPerson: { try core.checkPerson(request) })
            return try DriverPointer.perform(method: method, args: request.params["args"] as! [Any], context: context, sink: pointer)
          } catch let failure as DriverPointerFault {
            var fault = DriverFault(failure.code, failure.message, unhealthy: failure.unhealthy)
            fault.disposition = failure.json; throw fault
          }
        })
      }
      runtime.register(method: "spaceMetrics") { _, _ in ["inputs": fakeInputs, "keys": keyPosts, "pointer": pointer.posts] }
    `;
    const composed = macDriverSource();
    assert.ok(composed.includes('runtime.install(driverRegistrars)'));
    await writeFile(source, composed.replace('runtime.install(driverRegistrars)',
      'runtime.install(driverRegistrars)\n' + registration));
    const built = await run('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
      '-module-cache-path', join(root, 'modules'), source, '-o', binary]);
    assert.equal(built.code, 0, built.stderr);
    t.diagnostic(`fixture-only driver binary: ${(await stat(binary)).size} bytes`);
    const send = async (data, requests) => {
      await writeFile(dataFile, JSON.stringify(data));
      const result = await run(binary, ['--fixture', dataFile], requests.map(([method, params = {}], i) => JSON.stringify({
        protocol: 'sleight.driver/1', platform: 'darwin', nonce, id: i + 1, method, params, deadline: Date.now() + 10000,
      }) + '\n').join(''), { ...process.env, SLEIGHT_DRIVER_NONCE: nonce });
      assert.equal(result.code, 0, result.stderr);
      return result.stdout.trim().split('\n').map(line => JSON.parse(line));
    };
    const action = ['setValue', { ...binding, readId: 1, args: [0, 'fixture'], read: 'none' }];
    for (const [name, state, attributes, admitted, reason] of [
      ['current Space', {}, {}, true],
      ['another Space', { onScreen: false }, {}, false, 'another Space or off screen'],
      ['missing optional CG on-screen key', { onScreen: undefined }, {}, false, 'another Space or off screen'],
      ['another full-screen Space', { onScreen: false, fullScreen: true }, { AXFullScreen: true }, false, 'full-screen Space outside'],
      ['current full-screen Space', {}, { AXFullScreen: true }, true],
      ['current Split View tile', { bounds: { ...window.bounds, width: 50 } }, { AXFullScreen: true }, false, 'Split View'],
      ['minimized window', { onScreen: false }, { AXMinimized: true }, false, 'minimized'],
      ['minimized on-screen metadata', {}, { AXMinimized: true }, false, 'minimized'],
      ['hidden app', { onScreen: false, hidden: true }, {}, false, 'hidden'],
      ['nonzero window layer', { layer: 3 }, {}, false, 'could not be verified'],
      ['unknown on-screen state', { onScreen: null }, {}, false, 'could not be verified'],
      ['unknown hidden state', { hidden: null }, {}, false, 'could not be verified'],
      ['unknown minimized state', {}, { AXMinimized: null }, false, 'could not be verified'],
      ['unknown full-screen state', {}, { AXFullScreen: null }, false, 'could not be verified'],
    ]) await t.test(`${name}: read succeeds, input ${admitted ? 'reaches' : 'refuses before'} fake sink`, async () => {
      const data = fixture(state, attributes);
      data.trees['7'].frame = data.windows[0].bounds;
      const rows = await send(data, [['getAXState', binding], action, ['spaceMetrics']]);
      assert.equal(rows[0].ok, true);
      assert.equal(rows[0].result.window.onScreen, Object.hasOwn(state, 'onScreen') ? state.onScreen === undefined ? false : state.onScreen : true);
      assert.equal(rows[0].result.window.minimized, attributes.AXMinimized === undefined ? false : attributes.AXMinimized);
      assert.equal(rows[0].result.window.fullScreen, attributes.AXFullScreen === undefined ? false : attributes.AXFullScreen);
      assert.equal(rows[1].ok, admitted);
      assert.equal(rows[2].result.inputs, admitted ? 1 : 0);
      if (!admitted) {
        assert.equal(rows[1].error.code, 'NO_WINDOWS_AVAILABLE');
        assert.equal(rows[1].error.delivery, 'not-sent'); assert.equal(rows[1].error.retry, 'safe');
        assert.ok(rows[1].error.message.includes(reason), rows[1].error.message);
        assert.ok(Object.values(MAC_WINDOW_REFUSALS).includes(rows[1].error.message), rows[1].error.message);
        assert.match(rows[1].error.message, /ask the user.*Input refused/);
      }
    });
    for (const [method, args, metric] of [['click', [0], 'pointer'], ['doubleClick', [0], 'pointer'],
      ['rightClick', [0], 'pointer'], ['scroll', [0, 'down', 1], 'pointer'],
      ['drag', [0, 0], 'pointer'], ['pressKey', ['Return'], 'keys'], ['typeText', ['x'], 'keys'],
      ['modifiers', [{ keys: ['shift'], state: 'down' }], 'keys'], ['setValue', [0, 'fixture'], 'inputs'],
      ['selectText', [0, 'fixture'], 'inputs'], ['performSecondaryAction', [0, 'Show Menu'], 'inputs']]) {
      for (const onScreen of [true, false]) await t.test(`real ${method} registration ${onScreen ? 'admits current Space' : 'refuses off-Space'} before its fake sink`, async () => {
        const rows = await send(fixture({ onScreen }), [['getAXState', binding],
          [method, { ...binding, readId: 1, args, read: 'none' }], ['spaceMetrics']]);
        assert.equal(rows[0].ok, true);
        assert.equal(rows[1].ok, onScreen, JSON.stringify({ reply: rows[1], sink: rows[2].result }));
        assert.equal(rows[2].result[metric] > 0, onScreen);
        if (!onScreen) {
          assert.equal(rows[1].error.code, 'NO_WINDOWS_AVAILABLE');
          assert.equal(rows[1].error.delivery, 'not-sent'); assert.equal(rows[1].error.retry, 'safe');
          if (metric !== 'keys') assert.equal(rows[1].error.message, MAC_WINDOW_REFUSALS.otherSpace);
          assert.deepEqual(rows[2].result, { inputs: 0, keys: 0, pointer: 0 });
        }
      });
    }
    for (const displays of [undefined, [], [{ ...window.bounds, width: 0 }], [{ x: 0 }]]) {
      await t.test(`full-screen input fails closed with unreadable display geometry ${JSON.stringify(displays)}`, async () => {
        const data = fixture({}, { AXFullScreen: true }); data.displays = displays;
        const rows = await send(data, [['getAXState', binding], action, ['spaceMetrics']]);
        assert.equal(rows[0].ok, true); assert.equal(rows[0].result.window.fullScreenTile, null);
        assert.equal(rows[1].error.code, 'NO_WINDOWS_AVAILABLE');
        assert.match(rows[1].error.message, /could not be verified/); assert.equal(rows[2].result.inputs, 0);
      });
    }
    await t.test('missing CG key with no AX window gives other-Space advice and refuses input', async () => {
      const data = fixture({ onScreen: undefined }); data.axWindows = [];
      const rows = await send(data, [['getAXState', binding], action, ['spaceMetrics']]);
      assert.equal(rows[0].error.message, 'IDENTITY_UNVERIFIED\n' + MAC_WINDOW_NOTICES.otherSpace);
      assert.match(rows[1].error.message, /another Space or off screen/);
      assert.equal(rows[2].result.inputs, 0);
    });
    for (const [name, snapshots, input, metric] of [
      ['between read and input', [[window], [{ ...window, onScreen: false }]], action],
      // Read, pointer context and element binding see the current Space. Only
      // the final identity/person guard sees the move, before the first post.
      ['between input bind and posting guard', [[window], [window], [window], [{ ...window, onScreen: false }]],
        ['click', { ...binding, readId: 1, args: [0], read: 'none' }]],
      // Read and keyboard binding see the current Space. The first per-event
      // person guard rebinds after the move, before any key reaches the sink.
      ['between pressKey bind and posting guard', [[window], [window], [{ ...window, onScreen: false }]],
        ['pressKey', { ...binding, readId: 1, args: ['Return'], read: 'none' }], 'keys'],
      // Read, then two checked passes (person guard, window bind, element bind).
      // Only the final person guard sees the move, before the AXValue mutation.
      ['between setValue bind and posting guard', [...Array.from({ length: 7 }, () => [window]), [{ ...window, onScreen: false }]],
        action, 'inputs'],
    ]) await t.test(`a window moving Space ${name} refuses without reaching the fake sink`, async () => {
      const data = fixture(); data.windowSnapshots = snapshots;
      const rows = await send(data, [['getAXState', binding], input, ['spaceMetrics']]);
      assert.equal(rows[0].ok, true); assert.equal(rows[0].result.window.onScreen, true);
      assert.equal(rows[1].ok, false, JSON.stringify({ reply: rows[1], sink: rows[2].result }));
      assert.equal(rows[1].error.code, 'NO_WINDOWS_AVAILABLE'); assert.equal(rows[1].error.delivery, 'not-sent');
      assert.equal(rows[1].error.retry, 'safe');
      if (metric !== 'keys') assert.equal(rows[1].error.message, MAC_WINDOW_REFUSALS.otherSpace);
      assert.deepEqual(rows[2].result, { inputs: 0, keys: 0, pointer: 0 });
    });
    for (const [name, axWindows] of [
      ['absent AX window', []], ['wrong AX number', [{ ...tree, AXWindowNumber: 8 }]],
      ['wrong AX owner', [{ ...tree, pid: 99 }]], ['ambiguous AX match', [tree, tree]],
    ]) await t.test(`off-Space reads fail closed with ${name}`, async () => {
      const data = fixture({ onScreen: false }); data.axWindows = axWindows;
      const rows = await send(data, [['getAXState', binding], ['spaceMetrics']]);
      assert.equal(rows[0].error.code, 'IDENTITY_UNVERIFIED');
      assert.equal(rows[0].error.message, 'IDENTITY_UNVERIFIED\n' + MAC_WINDOW_NOTICES.otherSpace);
      assert.equal(rows[0].result, undefined); assert.equal(rows[1].result.inputs, 0);
    });
    await t.test('a named off-Space window cannot borrow the only AX window with shared CG bounds', async () => {
      const data = fixture({ onScreen: false });
      data.windows.push({ ...window, windowId: '8' });
      const candidate = { ...tree }; delete candidate.AXWindowNumber;
      data.axWindows = [candidate];
      const rows = await send(data, [['getAXState', binding], ['spaceMetrics']]);
      assert.equal(rows[0].error.code, 'IDENTITY_UNVERIFIED');
      assert.equal(rows[0].error.message, 'IDENTITY_UNVERIFIED\n' + MAC_WINDOW_NOTICES.otherSpace);
      assert.equal(rows[0].result, undefined); assert.equal(rows[1].result.inputs, 0);
    });
  });
