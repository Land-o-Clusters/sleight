import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { macInputSurfaceChanged } from '../plugins/sleight/lib/mac-driver/surfaces.mjs';
import { createMacSafety } from '../plugins/sleight/lib/mac-safety.mjs';
import { evaluateAppPolicy } from '../plugins/sleight/lib/app-policy.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { windowFromText, elementLines, elementParents, sameElement, plainFieldRemap, menuRoot, differentFocusTarget, isPaymentTarget } from '../plugins/sleight/lib/document-scope.mjs';

import { stateFields, structuralKey, createReadCompactor, GUARD_MARK } from '../plugins/sleight/lib/compact-reads.mjs';
import { ROLE_CASES, SUBROLE_CASES, excelTree, calculatorTree, recordedFixture } from './fixtures/mac-driver-recorded-tree.mjs';

const nonce = 'a'.repeat(64);
const envelope = (id, method, params = {}, extra = {}) => ({ protocol: 'sleight.driver/1', platform: 'darwin', nonce,
  id, method, params, deadline: Date.now() + 5000, ...extra });

test('native driver compiles and validates stdin with a fake inventory only', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-driver-native-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'driver.swift'), binary = join(root, 'driver'), fixture = join(root, 'fixture.json');
  const additions = `
    runtime.register(method: "fixtureWindowPolicy") { request, core in
        let root = DriverNode(fake: request.params["root"] as? DriverObject ?? ["AXRole": "AXWindow", "AXSubrole": "AXSettingsWindow", "AXIdentifier": "document"], path: "policy")
        let focused = DriverNode(fake: request.params["focused"] as? DriverObject ?? [:], path: "focus")
        return try driverWindowPolicy([:], root: root, focused: focused, secureInput: true, request: request)
    }
    var fixtureActions = 0, fixtureSettles = 0
    runtime.register(method: "setValue") { request, core in
        fixtureActions += 1
        let args = request.params["args"] as! [Any]
        if args.last as? String == "before" { throw DriverFault("ELEMENT_DISABLED") }
        try request.admitInput()
        if args.last as? String == "after" { throw DriverFault("ACTION_UNCONFIRMED") }
        return ["window": try core.inventory.bound(request.params), "delivery": "sent-unverified", "retry": "read-first",
                "personTookOver": false, "settled": false, "text": "must be removed with read none", "extra": "not in the result allowlist"]
    }
    if core.inventory.fixture?["omitSettle"] as? Bool != true { runtime.register(method: "settle") { request, core in
        try request.keys(["windowId", "processStart"], optional: ["extendForBusy", "busyCapMs", "afterReadId"])
        fixtureSettles += 1
        return ["settled": true, "reason": "quiet", "busyElements": 0]
    }
    }
    runtime.register(method: "fixtureFutureInput") { _, _ in
        fixtureActions += 1
        return ["entered": true]
    }
    runtime.register(method: "fixtureMetrics") { _, _ in ["actions": fixtureActions, "settles": fixtureSettles] }
    runtime.register(method: "fixtureSecondary") { request, core in
        try request.keys(["windowId", "processStart", "readId", "target", "name"])
        guard let name = request.params["name"] as? String else { throw DriverFault("INVALID_PARAMS") }
        let (_, action) = try core.resolveSecondaryAction(request.params, name: name, request: request)
        return ["action": action]
    }
  `;
  // Exercise the unsupported-settle wrapper with an intentionally older helper.
  // The production helper now installs RT26's settle registrar by default.
  let installed = macDriverSource();
  if (process.env.GL8_MUTANT === 'delimiter') {
    const anchor = 'return role + (collision ? " ()" : "")';
    assert.ok(installed.includes(anchor), 'renderer mutation anchor');
    installed = installed.replace(anchor, 'return role');
  }
  const checked = process.env.GL1_NATIVE_MUTANT === 'disabled'
    ? installed.replace('let driverInputGateEnabled = true', 'let driverInputGateEnabled = false') : installed;
  const composed = checked.replace('runtime.install(driverRegistrars)',
    'runtime.install(core.inventory.fixture?["omitSettle"] as? Bool == true ? [{ $0.registerCapture() }] : driverRegistrars)');
  // Delay only the fake provider in this compiled fixture. Production has no
  // request option or environment switch that can enable the delay.
  const slowProbe = composed.replace('if let fixture = fixture { return fixture["apps"] as? [DriverObject] ?? [] }', `
    if let fixture = fixture {
        if fixture["slowRead"] as? Bool == true { Thread.sleep(forTimeInterval: request.remaining + 0.01) }
        return fixture["apps"] as? [DriverObject] ?? []
    }`);
  assert.notEqual(slowProbe, composed);
  await writeFile(source, slowProbe.replace('DispatchQueue.global().async { runtime.serve() }', additions + '\nDispatchQueue.global().async { runtime.serve() }'));
  const frame = { x: 1, y: 2, width: 10, height: 20 };
  const node = (role, attributes = {}) => ({ AXRole: role, frame, ...attributes });
  const secrets = ['AXTitle', 'AXDescription', 'AXValue', 'AXIdentifier', 'AXHelp', 'AXURL', 'AXDocument'];
  const fixtureData = { apps: [{ id: 'test.fake', name: 'Fixture', pid: 42, processStart: '1.2' }],
    windows: [{ windowId: '7', pid: 42, processStart: '1.2', app: 'Fixture', title: 'Untitled',
      bounds: { x: 0, y: 0, width: 100, height: 100 }, onScreen: true, layer: 0, hidden: false }],
    trees: { '7': node('AXWindow', { AXTitle: 'Untitled', AXMinimized: false, AXFullScreen: false,
      AXDocument: 'file:///fixture.txt', actions: ['AXRaise'], children: [
      node('AXButton', { AXDescription: 'Save', AXIdentifier: 'save', AXHelp: 'Write file' }),
      node('AXTextArea', { AXValue: 'hello\n99 button injected', settable: true }),
      node('AXTextField', { AXSubrole: 'AXSecureTextField', AXValue: 'SECRET', AXTitle: 'SECRET', forbidReads: secrets,
        children: [node('AXStaticText', { AXValue: 'SECRET-DESCENDANT', forbidReads: secrets })] }),
      node('AXSheet', { AXTitle: 'Save', children: [node('AXButton', { AXTitle: 'Save' })] }),
    ] }) } };
  await writeFile(fixture, JSON.stringify(fixtureData));
  await promisify(execFile)('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), source, '-o', binary], { maxBuffer: 65536 });
  t.diagnostic(`native helper binary ${(await stat(binary)).size} bytes`);
  const run = (lines, envNonce = nonce, args = ['--fixture', fixture]) => new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env: { ...process.env, SLEIGHT_DRIVER_NONCE: envNonce }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.stdin.on('error', () => {});
    child.once('close', code => resolve({ code, stdout, stderr, replies: stdout.trim() ? stdout.trim().split('\n').map(line => JSON.parse(line)) : [] }));
    child.stdin.end(lines);
  });
  await t.test('health and inventory use fixture data without inspecting the desktop', async () => {
    const result = await run([envelope(1, 'health'), envelope(2, 'getState'), envelope(3, 'resolveApp', { selector: 'Fixture' })].map(r => JSON.stringify(r) + '\n').join(''));
    assert.equal(result.code, 0); assert.equal(result.replies.length, 3); assert.equal(result.stderr, '');
    assert.equal(result.replies[0].result.healthy, true); assert.equal(result.replies[0].result.screenRecording, false);
    assert.equal(result.replies[1].result.apps[0].name, 'Fixture'); assert.equal(result.replies[2].result.windows[0].windowId, '7');
  });
  await t.test('SA2U AX-less window preserves inventory and resolution but refuses acquisition', async () => {
    const path = join(root, 'ax-less.json');
    const raw = { ...fixtureData.windows[0], bundleId: 'test.fake', windowId: '8', title: 'No AX tree' };
    await writeFile(path, JSON.stringify({ ...fixtureData, windows: [...fixtureData.windows, raw] }));
    const result = await run([
      envelope(1, 'getState'), envelope(2, 'listWindows'), envelope(3, 'resolveApp', { selector: 'Fixture' }),
      envelope(4, 'verifyWindowIdentity', { windowId: '8', processStart: '1.2' }),
      envelope(6, 'getAXState', { windowId: '8', processStart: '1.2' }),
    ].map(row => JSON.stringify(row) + '\n').join(''), nonce, ['--fixture', path]);
    assert.equal(result.code, 0); assert.equal(result.replies.length, 5);
    for (const reply of result.replies.slice(0, 3)) {
      assert.equal(reply.ok, true, JSON.stringify(reply));
      assert.equal(reply.result.windows.length, 2);
      assert.deepEqual(reply.result.windows.find(window => window.windowId === '8'), raw);
    }
    assert.deepEqual(result.replies[0].result.windows, [...fixtureData.windows, raw]);
    assert.deepEqual(result.replies[1].result.windows, [...fixtureData.windows, raw]);
    assert.equal(result.replies[2].result.windows[0].identityVerified, true);
    for (const reply of result.replies.slice(3)) {
      assert.equal(reply.ok, false); assert.equal(reply.error.code, 'AX_UNAVAILABLE');
    }
    const calls = [], cards = [];
    const safety = createMacSafety({ driver: { async request(method, params) {
      calls.push(method);
      const result = await run(JSON.stringify(envelope(1, method, params)) + '\n', nonce, ['--fixture', path]);
      const reply = result.replies[0];
      if (!reply.ok) throw Object.assign(Error(reply.error.code), reply.error);
      return reply.result;
    } }, policy: () => ({ allow: true }), targetParents: () => [42, 1],
      ancestry: () => [{ pid: 90, path: '/bin/zsh' }],
      approve: card => { cards.push(card); return true; },
      permissions: { app() {}, page() {}, sitesLimited: () => false },
      lease: { acquire: () => assert.fail('no lease for AX-less window'), close() {} } });
    try {
      await assert.rejects(safety.request('getApp', { selector: { windowId: '8' } }), { code: 'AX_UNAVAILABLE' });
      assert.deepEqual(calls, ['resolveApp', 'verifyWindowIdentity']); assert.equal(cards.length, 1);
    } finally { safety.close(); }
  });
  for (const attribute of ['AXSubrole', 'AXIdentifier']) {
    await t.test(`SA2U unreadable root ${attribute} refuses policy sampling`, async () => {
      const value = { AXRole: 'AXWindow', AXSubrole: 'AXSettingsWindow', AXIdentifier: 'document' };
      value[attribute] = { axError: -25204 };
      const result = await run(JSON.stringify(envelope(1, 'fixtureWindowPolicy', { root: value })) + '\n');
      assert.equal(result.code, 0); assert.equal(result.replies[0].ok, false);
      assert.equal(result.replies[0].error.code, 'AX_UNAVAILABLE');
    });
  }
  await t.test('installed main registers input and keeps local reads available', async () => {
    const requests = [envelope(1, 'ping'), envelope(2, 'inputGateState'),
      envelope(3, 'localTool', { args: ['keyboard-taps.js', {}] }),
      envelope(4, 'localTool', { args: ['app-health.js', { app: 'Absent' }] })];
    const result = await run(requests.map(row => JSON.stringify(row) + '\n').join(''));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.replies.length, requests.length);
    assert.ok(result.replies[0].result.methods.includes('localTool'));
    for (const method of ['click', 'doubleClick', 'rightClick', 'drag', 'typeText', 'pressKey', 'paste'])
      assert.equal(result.replies[0].result.methods.includes(method), true, method);
    assert.deepEqual(result.replies[1].result, { enabled: true });
    assert.deepEqual(result.replies[2].result, { ok: true, taps: [] });
    assert.equal(result.replies[3].result.status, 'absent');
  });
  await t.test('production local-tool registrar admits every read-only variant', async () => {
    const reads = [['keyboard-taps.js', {}], ['app-health.js', { app: 'Absent' }],
      ['menubar.js', { caller: 'menu_bar', op: 'apps' }], ['menubar.js', { caller: 'notifications', op: 'notifications' }],
      ['stuck-escape.js', { op: 'check' }], ['open-file-window.js', {}]];
    const result = await run(reads.map((args, index) => JSON.stringify(envelope(index + 1, 'localTool', { args })) + '\n').join(''));
    assert.equal(result.code, 0, result.stderr); assert.equal(result.replies.length, reads.length);
    for (const reply of result.replies) assert.equal(reply.ok, true, JSON.stringify(reply));
  });
  await t.test('a slow production read probe times out without retiring the helper or its retained read', async () => {
    const path = join(root, 'slow-local.json');
    await writeFile(path, JSON.stringify({ ...fixtureData, localTools: { slowRead: true } }));
    const requests = [envelope(1, 'getAXState', { windowId: '7', processStart: '1.2' }),
      envelope(2, 'localTool', { args: ['app-health.js', { app: 'Absent' }] }, { deadline: Date.now() + 2000 }),
      envelope(3, 'ping'),
      envelope(4, 'resolveElement', { windowId: '7', processStart: '1.2', readId: 1, target: 1 })];
    const result = await run(requests.map(row => JSON.stringify(row) + '\n').join(''), nonce, ['--fixture', path]);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.replies.length, 4);
    assert.equal(result.replies[0].ok, true);
    assert.equal(result.replies[1].ok, true);
    assert.deepEqual(result.replies[1].result, { ok: false, timedOut: true, helperHealthy: true,
      delivery: 'not-sent', retry: 'safe',
      error: 'Local tool timed out; the shared helper is still healthy. Nothing was sent.' });
    assert.equal(result.replies[2].result.healthy, true);
    assert.equal(result.replies[3].result.element.number, 1);
  });
  for (const [name, lines] of [
    ['wrong nonce', JSON.stringify(envelope(1, 'ping', {}, { nonce: 'b'.repeat(64) })) + '\n'],
    ['duplicate id', [envelope(1, 'ping'), envelope(1, 'ping')].map(r => JSON.stringify(r) + '\n').join('')],
    ['duplicate escaped key', JSON.stringify(envelope(1, 'ping')).replace('"method":"ping"', '"method":"ping","meth\\u006fd":"health"') + '\n'],
    ['incomplete EOF', '{'], ['bad UTF8', Buffer.from([0xff, 10])],
    ['boolean id', JSON.stringify(envelope(true, 'ping')) + '\n'],
    ['unknown envelope key', JSON.stringify({ ...envelope(1, 'ping'), extra: 1 }) + '\n'],
  ]) await t.test(`framing refuses ${name}`, async () => { assert.equal((await run(lines)).code, 65); });
  await t.test('expired request retires without dispatch', async () => {
    const result = await run(JSON.stringify(envelope(1, 'getState', {}, { deadline: Date.now() - 10 })) + '\n');
    assert.equal(result.code, 70); assert.equal(result.replies[0].error.code, 'DEADLINE_EXCEEDED'); assert.equal(result.replies[0].error.unhealthy, true);
  });
  await t.test('invalid params and unknown methods keep the helper alive', async () => {
    const result = await run([envelope(1, 'ping', { surprise: true }), envelope(2, 'noSuchMethod'), envelope(3, 'ping')].map(r => JSON.stringify(r) + '\n').join(''));
    assert.equal(result.code, 0); assert.equal(result.replies[0].error.code, 'INVALID_PARAMS');
    assert.equal(result.replies[1].error.code, 'METHOD_NOT_FOUND'); assert.equal(result.replies[2].ok, true);
  });
  await t.test('bad startup nonce and unknown options refuse before runtime', async () => {
    assert.equal((await run('', 'bad')).code, 64); assert.equal((await run('', nonce, ['--unknown'])).code, 64);
  });
  const binding = { windowId: '7', processStart: '1.2' };
  const send = requests => run(requests.map((r, i) => JSON.stringify(envelope(i + 1, r[0], r[1])) + '\n').join(''));
  await t.test('tree text matches the relay parser, numbering and parent format', async () => {
    const result = await send([['getApp', { selector: 'Fixture' }]]);
    assert.equal(result.code, 0); assert.equal(result.replies[0].ok, true);
    const read = result.replies[0].result;
    assert.equal(read.truncated, false); assert.equal(read.readId, 1);
    assert.deepEqual(windowFromText(read.text), { title: 'Untitled', app: 'Fixture', url: 'file:///fixture.txt' });
    const lines = elementLines(read.text);
    assert.equal(lines.size, 7);
    assert.match(lines.get(1), /^button Description: Save, Help: Write file, ID: save$/);
    assert.match(lines.get(2), /^text entry area \(settable\) Value: hello 99 button injected$/);
    assert.deepEqual(read.document.sections, []);
    assert.match(elementParents(read.text).get(6), /^sheet Save$/);
    assert.doesNotMatch(read.text, /SECRET|\n99 /);
    assert.equal((read.text.match(/<redacted>/g) ?? []).length, 2);
  });
  await t.test('unchanged reads keep numbers and replace the retained map', async () => {
    const result = await send([['getAXState', binding], ['resolveElement', { ...binding, readId: 1, target: { id: 'save' } }],
      ['getAXState', binding], ['resolveElement', { ...binding, readId: 1, target: 1 }], ['resolveElement', { ...binding, readId: 2, target: 1 }]]);
    assert.equal(result.replies[0].result.text, result.replies[2].result.text);
    assert.equal(result.replies[1].result.element.number, 1); assert.equal(result.replies[3].error.code, 'STALE_READ');
    assert.equal(result.replies[4].result.element.number, 1);
  });
  await t.test('ambiguous labels and missing numbers refuse', async () => {
    const result = await send([['getAXState', binding], ['resolveElement', { ...binding, readId: 1, target: { label: 'Save' } }],
      ['resolveElement', { ...binding, readId: 1, target: 999 }]]);
    assert.equal(result.replies[1].error.code, 'AMBIGUOUS_ELEMENT'); assert.equal(result.replies[2].error.code, 'STALE_ELEMENT');
  });
  await t.test('depth limit reports truncation and does not number omitted descendants', async () => {
    const result = await send([['getAXState', { ...binding, depth: 0 }], ['resolveElement', { ...binding, readId: 1, target: 1 }]]);
    assert.equal(result.replies[0].result.truncated, true); assert.equal(elementLines(result.replies[0].result.text).size, 1);
    assert.equal(result.replies[1].error.code, 'STALE_ELEMENT');
  });
  await t.test('wrong process incarnation and invalid depth refuse', async () => {
    const result = await send([['getAXState', { ...binding, processStart: 'changed' }], ['getAXState', { ...binding, depth: true }],
      ['getApp', { selector: 'Fixture', launch: 1 }], ['resolveApp', { selector: 'Fixture', launch: true }]]);
    assert.deepEqual(result.replies.map(r => r.error.code), ['IDENTITY_CHANGED', 'INVALID_PARAMS', 'INVALID_PARAMS', 'INVALID_PARAMS']);
  });
  await t.test('explicit window selection and metadata identity are available', async () => {
    const result = await send([['getApp', { selector: { windowId: '7' }, launch: false }], ['verifyWindowIdentity', binding],
      ['getApp', { selector: { windowId: '8' } }]]);
    assert.equal(result.replies[0].result.window.windowId, '7'); assert.equal(result.replies[1].result.window.identityVerified, true);
    assert.equal(result.replies[2].error.code, 'WINDOW_NOT_FOUND');
  });
  await t.test('wide trees stop with explicit truncation at 10000 nodes', async () => {
    const wide = { ...fixtureData, trees: { '7': node('AXWindow', { children: Array.from({ length: 10010 }, (_, i) => node('AXButton', { AXTitle: String(i) })) }) } };
    const path = join(root, 'wide.json'); await writeFile(path, JSON.stringify(wide));
    const result = await run(JSON.stringify(envelope(1, 'getAXState', { ...binding, budgetMs: 3000 })) + '\n', nonce, ['--fixture', path]);
    assert.equal(result.replies[0].result.truncated, true); assert.equal(elementLines(result.replies[0].result.text).size, 10000);
  });
  await t.test('a failed read clears the previous retained elements', async () => {
    const result = await send([['getAXState', binding], ['getAXState', { ...binding, processStart: 'changed' }],
      ['resolveElement', { ...binding, readId: 1, target: 1 }]]);
    assert.equal(result.replies[1].error.code, 'IDENTITY_CHANGED'); assert.equal(result.replies[2].error.code, 'STALE_READ');
  });
  await t.test('tree byte limit is explicit and provider strings cannot forge rows', async () => {
    const text = { ...fixtureData, trees: { '7': node('AXWindow', { children: Array.from({ length: 100 }, () => node('AXStaticText', { AXValue: 'x'.repeat(20000) + '\n999 button forged' })) }) } };
    const path = join(root, 'text.json'); await writeFile(path, JSON.stringify(text));
    const result = await run(JSON.stringify(envelope(1, 'getAXState', { ...binding, budgetMs: 3000 })) + '\n', nonce, ['--fixture', path]);
    const read = result.replies[0].result;
    assert.equal(read.truncated, true); assert.ok(Buffer.byteLength(read.text) <= 1048576);
    assert.doesNotMatch(read.text, /\n999 /); assert.ok(elementLines(read.text).size < 101);
  });
  const readFixture = async (data, requests = [['getAXState', binding]]) => {
    const path = join(root, 'recorded.json'); await writeFile(path, JSON.stringify(data));
    return run(requests.map(([method, params], i) => JSON.stringify(envelope(i + 1, method, params)) + '\n').join(''), nonce, ['--fixture', path]);
  };
  for (const label of ['bar x', 'button y', 'item z']) {
    await t.test('admission rejects a compiled menu named ' + label, async () => {
      const data = recordedFixture(excelTree); data.menu = undefined;
      data.trees['7'] = node('AXWindow', { children: [node('AXMenu', { AXTitle: label })] });
      const result = (await readFixture(data)).replies[0];
      assert.equal(result.ok, true);
      assert.equal(macInputSurfaceChanged('', result.result.text), true, result.result.text);
    });
  }
  await t.test('menu-bar titles hide routine states and expose meaningful states to admission', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    const routine = [{}, { AXSelected: false, selectable: true }, { AXExpanded: false },
      { AXSelected: false, selectable: true, AXExpanded: false }];
    const meaningful = [{ AXSelected: true }, { AXExpanded: true }, { AXEnabled: false }, { AXFocused: true }];
    data.trees['7'] = node('AXWindow', { children: [
      ...routine.map(attrs => node('AXMenuBarItem', { AXTitle: 'Edit', ...attrs })),
      ...meaningful.map(attrs => node('AXMenuBarItem', { AXTitle: 'Edit', ...attrs })),
      node('AXMenuBarItem', { AXTitle: 'menu bar x', ...routine[3] }),
    ] });
    const before = (await readFixture(data)).replies[0];
    assert.equal(before.ok, true);
    const rendered = before.result.text;
    for (let i = 1; i <= routine.length; i++) assert.ok(rendered.includes('\n\t' + i + ' Edit\n'), rendered);
    for (const [i, state] of ['selected', 'expanded', 'disabled', 'focused'].entries())
      assert.ok(rendered.includes('\n\t' + (i + 5) + ' menu bar item (' + state + ') Edit'), rendered);
    assert.match(rendered, /9 menu bar item \(selectable, collapsed\) menu bar x/);
    data.trees['7'].children[3].AXSelected = true;
    const after = (await readFixture(data)).replies[0];
    assert.equal(after.ok, true);
    assert.equal(macInputSurfaceChanged(rendered, after.result.text), true, 'bare title gaining selected stops input');
  });
  await t.test('role delimiters prevent labels from changing role or state classification', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    data.trees['7'] = node('AXWindow', { children: [
      ...['bar x', 'button y', 'item z', '(disabled, collapsed) Edit'].map(AXTitle => node('AXMenu', { AXTitle })),
      node('AXMenuItem', { AXTitle: '(selected) Undo' }),
      node('AXMenuBarItem', { AXTitle: 'menu bar x' }),
      node('AXMenuBarItem', { AXTitle: 'Edit', AXSelected: true }),
    ] });
    const result = (await readFixture(data)).replies[0];
    assert.equal(result.ok, true);
    for (const [i, label] of ['bar x', 'button y', 'item z', '(disabled, collapsed) Edit'].entries())
      assert.ok(result.result.text.includes('\n\t' + (i + 1) + ' menu () ' + label));
    assert.match(result.result.text, /5 menu item \(\) \(selected\) Undo/);
    assert.match(result.result.text, /6 menu bar item menu bar x/);
    assert.match(result.result.text, /7 menu bar item \(selected\) Edit/);
  });
  await t.test('SA2S production policy sampler carries root identity and secure focus without reading values', async () => {
    const results = (await send(['AXSecureTextField', 'AXTextField', undefined].map(role => ['fixtureWindowPolicy', {
      focused: { ...role ? { AXRole: role } : {}, forbidReads: ['AXValue', 'AXTitle', 'AXDescription'] },
    }]))).replies;
    for (const [index, row] of results.entries()) {
      assert.equal(row.ok, true);
      const verdict = evaluateAppPolicy({ bundleId: 'com.apple.TextEdit', executableName: 'TextEdit',
        processAncestry: [{ kind: 'non-app' }], windowTitle: 'Draft', operation: 'getAXState', ...row.result });
      assert.equal(verdict.category, 'settings-windows', 'native subrole must refuse an ordinary app settings read');
      assert.equal(verdict.allow, false);
      assert.equal(row.result.windowSubrole, 'AXSettingsWindow');
      assert.equal(row.result.windowIdentifier, 'document');
      assert.equal(row.result.secureInput, true);
      if (index < 2) assert.equal(row.result.focusedSecureField, index === 0);
      else assert.equal(Object.hasOwn(row.result, 'focusedSecureField'), false);
    }
  });
  await t.test('SA2S every fixture window payload preserves policy keys and unreadable flags', async () => {
    for (const flags of [{ windowSubrole: 'AXSettingsWindow', windowIdentifier: 'settings', secureInput: true, focusedSecureField: true },
      { windowSubrole: 'AXStandardWindow', windowIdentifier: 'document', secureInput: false, focusedSecureField: false }, {}]) {
      const data = structuredClone(fixtureData); Object.assign(data.windows[0], flags);
      const replies = (await readFixture(data, [['resolveApp', { selector: 'Fixture' }],
        ['verifyWindowIdentity', binding], ['getAXState', binding]])).replies;
      assert.ok(replies.every(row => row.ok));
      for (const value of [replies[0].result.windows[0], replies[1].result.window, replies[2].result.window]) {
        for (const key of ['windowSubrole', 'windowIdentifier', 'secureInput', 'focusedSecureField'])
          assert.deepEqual({ present: Object.hasOwn(value, key), value: value[key] },
            { present: Object.hasOwn(flags, key), value: flags[key] });
      }
    }
  });
  for (const [name, engine] of [['Excel', excelTree], ['Calculator', calculatorTree]]) {
    await t.test(`recorded ${name} tree retains relay state, structural keys, menus and guards`, async () => {
      const data = recordedFixture(engine), result = await readFixture(data);
      assert.equal(result.code, 0); assert.equal(result.replies[0].ok, true);
      const native = result.replies[0].result.text;
      const expected = elementLines(engine), actual = elementLines(native);
      assert.ok(expected.size >= 121); assert.equal(actual.size, expected.size);
      for (const [number, line] of expected) {
        assert.deepEqual(stateFields(actual.get(number)), stateFields(line), `state ${number}: ${line}`);
        assert.equal(structuralKey(actual.get(number)), structuralKey(line), `structure ${number}: ${line}`);
        assert.equal(isPaymentTarget(actual.get(number)), isPaymentTarget(line), `payment ${number}`);
      }
      assert.deepEqual(windowFromText(native), windowFromText(engine));
      assert.equal(menuRoot(native), menuRoot(engine));
      const before = new Map(expected), after = new Map(actual);
      for (const [number, line] of expected) {
        const disabled = body => / \([^)]*\bdisabled\b/.test(body) ? body : body.replace(/^([a-z ]+?)(?= \(| [A-Z0-9]|$)/, '$1 (disabled)');
        assert.equal(sameElement(line, disabled(line)), sameElement(actual.get(number), disabled(actual.get(number))), `guard ${number}`);
        if (/^text field \(settable\)/.test(line)) assert.deepEqual(plainFieldRemap(before, number, after, new Set()), []);
      }
      const compact = text => {
        const c = createReadCompactor(); c.process([{ type: 'text', text }]);
        return c.process([{ type: 'text', text: GUARD_MARK + text }]).map(item => item.text);
      };
      // Same unchanged-read verdict through the production compactor, including
      // the private stateFields/structuralKey call sites used to align rows.
      assert.match(compact(native).join(''), /no change since the last full tree/);
      assert.match(compact(engine).join(''), /no change since the last full tree/);
      t.diagnostic(`${name}: ${actual.size} recorded rows, ${Buffer.byteLength(engine)} source bytes, ${Buffer.byteLength(native)} driver bytes`);
    });
  }
  await t.test('empty CG titles and hidden AX numbers match unique pid/bounds and retain the AX title', async () => {
    const data = recordedFixture(excelTree); data.axWindows = [data.trees['7']];
    const read = (await readFixture(data)).replies[0];
    assert.equal(read.ok, true); assert.equal(read.result.window.identityCorroboration, 'pid-bounds');
    assert.equal(read.result.window.title, 'Inventory-0000');
    for (const candidates of [[data.trees['7'], { ...data.trees['7'], AXTitle: 'Other' }],
      [{ ...data.trees['7'], pid: 99 }], [{ ...data.trees['7'], AXWindowNumber: 8 }]]) {
      const result = (await readFixture({ ...data, axWindows: candidates })).replies[0];
      assert.equal(result.error.code, 'IDENTITY_UNVERIFIED');
    }
    const overlapping = { ...data, windows: [data.windows[0], { ...data.windows[0], windowId: '8' }] };
    assert.equal((await readFixture(overlapping)).replies[0].error.code, 'IDENTITY_UNVERIFIED');
    const named = { ...data, windows: [{ ...data.windows[0], title: 'Inventory-0000' }],
      axWindows: [data.trees['7'], { ...data.trees['7'], AXTitle: 'Other' }] };
    assert.equal((await readFixture(named)).replies[0].ok, true);
  });
  await t.test('every role and subrole mapping has an explicit table case', async () => {
    const cases = [...ROLE_CASES.map(([role, label]) => ({ role, label })),
      ...SUBROLE_CASES.map(([subrole, label]) => ({ role: 'AXButton', subrole, label })),
      { role: 'AXFutureRole', label: 'container' }];
    const data = recordedFixture(excelTree);
    data.menu = undefined; data.trees['7'] = node('AXWindow', { children: cases.map(item => node(item.role, {
      AXSubrole: item.subrole, ...item.role === 'AXGroup' ? { AXIdentifier: 'role-fixture' } : {},
    })) });
    const rows = elementLines((await readFixture(data)).replies[0].result.text);
    for (const [i, item] of cases.entries()) assert.equal(rows.get(i + 1), item.label +
      ((item.role === 'AXSecureTextField' || item.subrole === 'AXSecureTextField') ? ' <redacted>' : item.role === 'AXGroup' ? ' ID: role-fixture' : ''), `${item.role}/${item.subrole ?? ''}`);
    t.diagnostic(`${ROLE_CASES.length} roles, ${SUBROLE_CASES.length} subroles, 1 unknown-role fallback`);
  });
  await t.test('focus, selected text, details, placeholder and a document URL survive relay parsing', async () => {
    const data = recordedFixture(excelTree);
    data.menu = undefined; data.trees['7'] = node('AXWindow', { AXTitle: 'Inventory-0000', AXDocument: 'file:///fixture.txt', children: [
      node('AXTextField', { AXIdentifier: 'field', AXFocused: true, AXValue: 'chosen', AXSelectedText: 'chosen', AXPlaceholderValue: 'Name', AXDetails: 'detail', settable: true }),
      node('AXComboBox', { AXExpanded: false, settable: true }),
      node('AXSwitch', { AXValue: true, settable: true }),
    ] });
    const text = (await readFixture(data)).replies[0].result.text;
    assert.match(text, /combo box \(collapsed, settable\)/); assert.match(text, /switch \(checked, settable, boolean\)/);
    assert.match(text, /Details: detail, Placeholder: Name, ID: field, Selected text: `chosen`/);
    assert.match(text, /sleight: the selection may identify the content the user means\.\nThe focused UI element is 1 text field/);
    assert.ok(stateFields(elementLines(text).get(1)).some(field => field === 'text:`chosen`'));
    assert.equal(windowFromText(text).url, 'file:///fixture.txt');
    assert.equal(differentFocusTarget(text, { number: 1, line: elementLines(text).get(1) }), undefined);
  });
  await t.test('context is echoed on errors and lock fields guard reads and captures with strict booleans', async () => {
    const context = { session: 'session', turn: 'turn', call: 'call' };
    const correlated = await run(JSON.stringify(envelope(1, 'noSuchMethod', {}, { context })) + '\n');
    assert.deepEqual(correlated.replies[0].context, context); assert.equal(correlated.replies[0].error.next, 'none');
    for (const invalid of [{ call: '\n' }, { call: 'x'.repeat(129) }, { other: 'x' }, null, { call: 1 }]) {
      assert.equal((await run(JSON.stringify(envelope(1, 'ping', {}, { context: invalid })) + '\n')).code, 65);
    }
    const data = recordedFixture(excelTree); data.session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true };
    const results = (await readFixture(data, [['health', {}], ['getAXState', binding], ['getScreenshot', binding],
      ['getAXState', { ...binding, allowLocked: 1 }], ['getAXState', { ...binding, allowLocked: true }]])).replies;
    assert.equal(results[0].result.sessionLocked, true); assert.equal(results[0].result.loginDone, true);
    assert.deepEqual(results.slice(1, 4).map(r => r.error.code), ['SCREEN_LOCKED', 'SCREEN_LOCKED', 'INVALID_PARAMS']);
    assert.equal(results[4].ok, true);
    assert.equal(results[0].result.apiVersion, 2); assert.match(results[0].result.build, /^[a-f0-9]{64}$/);
  });
  await t.test('getApp polls for the first window without launching from a fixture', async () => {
    const data = recordedFixture(excelTree); data.windowPollsBeforeReady = 3;
    const result = (await readFixture(data, [['getApp', { selector: 'Microsoft Excel' }]])).replies[0];
    assert.equal(result.ok, true); assert.equal(result.result.window.windowId, '7');
  });
  await t.test('registered fake actions honor none/full, input disposition and lock admission', async () => {
    const action = read => ({ ...binding, readId: 1, args: [1, 'value'], read });
    const results = (await send([['setValue', action('none')], ['fixtureMetrics', {}],
      ['setValue', action('full')], ['fixtureMetrics', {}],
      ['setValue', { ...action('none'), read: 'bad' }],
      ['setValue', { ...action('none'), args: [1, 'before'] }],
      ['setValue', { ...action('none'), args: [1, 'after'] }]])).replies;
    assert.deepEqual(Object.keys(results[0].result).sort(), ['delivery', 'personTookOver', 'retry', 'settled', 'timing', 'window']); assert.equal(results[1].result.settles, 0);
    assert.ok(results[0].result.timing.sendMs >= 0);
    assert.equal(results[0].result.timing.settleMs, 0);
    assert.equal(results[0].result.timing.postReadMs, 0);
    assert.equal(results[2].result.settled, true); assert.match(results[2].result.text, /Window:/);
    assert.deepEqual(results[3].result, { actions: 2, settles: 1 });
    assert.equal(results[4].error.code, 'INVALID_PARAMS');
    assert.equal(results[5].error.delivery, 'not-sent'); assert.equal(results[5].error.retry, 'safe');
    assert.equal(results[6].error.delivery, 'unknown'); assert.equal(results[6].error.retry, 'read-first');
    const data = recordedFixture(excelTree); data.session = { kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true };
    const locked = (await readFixture(data, [['setValue', action('none')], ['fixtureMetrics', { allowLocked: true }]])).replies;
    assert.equal(locked[0].error.code, 'SCREEN_LOCKED'); assert.equal(locked[0].error.delivery, 'not-sent');
    assert.equal(locked[1].result.actions, 0);
  });
  await t.test('future registered methods are session-guarded before their handler', async () => {
    for (const [session, code] of [
      [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true }, 'SCREEN_LOCKED'],
      [{ kCGSSessionOnConsoleKey: false, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: false }, 'DRIVER_INTERNAL'],
      [{ kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: false, CGSSessionScreenIsLocked: false }, 'DRIVER_INTERNAL'],
    ]) {
      const data = { ...recordedFixture(excelTree), session };
      const denied = (await readFixture(data, [['fixtureFutureInput', {}]])).replies[0];
      assert.equal(denied.error?.code, code);
      const override = (await readFixture(data, [['fixtureFutureInput', { allowLocked: true }]])).replies[0];
      if (code === 'SCREEN_LOCKED') assert.equal(override.result.entered, true);
      else assert.equal(override.error?.code, code, 'owner lock policy cannot bypass an inactive session');
    }
    const locked = { ...recordedFixture(excelTree), session: {
      kCGSSessionOnConsoleKey: true, kCGSessionLoginDoneKey: true, CGSSessionScreenIsLocked: true,
    } };
    const requests = ['ping', 'health', 'getState', 'listApps', 'listWindows'].map(method => [method, {}]);
    requests.push(['resolveApp', { selector: 'Microsoft Excel' }]);
    assert.ok((await readFixture(locked, requests)).replies.every(row => row.ok), 'six metadata methods remain available while locked');
    const rows = (await readFixture(locked, [['fixtureFutureInput', {}], ['fixtureUnregisteredFuture', {}], ['fixtureMetrics', { allowLocked: true }]])).replies;
    assert.deepEqual(rows.slice(0, 2).map(row => row.error?.code), ['SCREEN_LOCKED', 'SCREEN_LOCKED']);
    assert.equal(rows[2].result.actions, 0);
  });
  await t.test('full read refuses an unsupported settle before admitting any input', async () => {
    const data = { ...recordedFixture(excelTree), omitSettle: true };
    const action = { ...binding, readId: 1, args: [1, 'value'] };
    const rows = (await readFixture(data, [['setValue', { ...action, read: 'full' }], ['fixtureMetrics', {}],
      ['setValue', { ...action, read: 'none' }], ['fixtureMetrics', {}]])).replies;
    assert.deepEqual({ code: rows[0].error?.code, delivery: rows[0].error?.delivery, retry: rows[0].error?.retry },
      { code: 'ACTION_UNSUPPORTED', delivery: 'not-sent', retry: 'safe' });
    assert.equal(rows[1].result.actions, 0);
    assert.equal(rows[2].result.delivery, 'sent-unverified'); assert.equal(rows[3].result.actions, 1);
  });
  await t.test('secondary actions retain AX order and exclude ambiguous display names', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    data.trees['7'] = node('AXWindow', { children: [node('AXButton', {
      actions: ['AXPress', 'AXIncrement', 'AXDecrement', 'AXDelete', 'AXCancel', 'AXFirst', 'AXSecond'],
      actionDescriptions: { AXFirst: 'Duplicate', AXSecond: 'Duplicate' },
    }), node('AXScrollArea', { actions: ['AXScrollUp', 'AXScrollDown'] })] });
    const rows = (await readFixture(data, [['getAXState', binding], ['fixtureSecondary', {
      ...binding, readId: 1, target: 1, name: 'Duplicate',
    }]])).replies;
    assert.match(rows[0].result.text, /Secondary Actions: Increment, Decrement, Delete, Cancel/);
    assert.match(rows[0].result.text, /Secondary Actions: Scroll Up, Scroll Down/);
    assert.doesNotMatch(rows[0].result.text, /Duplicate/);
    assert.equal(rows[1].error.code, 'ACTION_UNSUPPORTED');
  });
  for (const budget of [300, 700, 3000]) await t.test(`a ${budget} ms request can walk a small fake tree`, async () => {
    const path = join(root, 'short-budget.json');
    await writeFile(path, JSON.stringify(fixtureData));
    const result = await run(JSON.stringify(envelope(1, 'getAXState', { ...binding, budgetMs: budget },
      { deadline: Date.now() + budget })) + '\n', nonce, ['--fixture', path]);
    assert.equal(result.code, 0); assert.equal(result.replies[0].ok, true);
    assert.equal(result.replies[0].result.truncated, false);
    assert.equal(elementLines(result.replies[0].result.text).size, 7);
  });
  await t.test('custom descriptions and humanized action names resolve only from the retained node list', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    data.trees['7'] = node('AXWindow', { children: [node('AXButton', { actions: ['AXPress', 'AXShowMenu', 'AXMyOperation'],
      actionDescriptions: { AXMyOperation: 'Open details' } }),
      node('AXTextField', { AXSubrole: 'AXSecureTextField' })] });
    const params = { ...binding, readId: 1, target: 1 };
    const results = (await readFixture(data, [['getAXState', binding], ['fixtureSecondary', { ...params, name: 'Open details' }],
      ['fixtureSecondary', { ...params, name: 'Show Menu' }], ['fixtureSecondary', { ...params, name: 'AXMyOperation' }],
      ['fixtureSecondary', { ...params, target: 2, name: 'Open details' }]])).replies;
    assert.match(results[0].result.text, /Secondary Actions: Show Menu, Open details/);
    assert.equal(results[1].result.action, 'AXMyOperation'); assert.equal(results[2].result.action, 'AXShowMenu');
    assert.equal(results[3].error.code, 'ACTION_UNSUPPORTED'); assert.equal(results[4].error.code, 'SECURE_FIELD');
  });
  await t.test('a long focus footer remains inside the tree byte cap without splitting Unicode', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    const long = '😀'.repeat(10000);
    data.trees['7'] = node('AXWindow', { children: [node('AXButton', { AXTitle: long, AXDescription: long, AXHelp: long,
      AXValue: long, AXIdentifier: long, AXDetails: long, AXFocused: true }),
      ...Array.from({ length: 100 }, () => node('AXStaticText', { AXValue: 'x'.repeat(16384) }))] });
    const reply = (await readFixture(data)).replies[0];
    assert.equal(reply.ok, true); assert.equal(reply.result.truncated, true);
    assert.ok(Buffer.byteLength(reply.result.text) <= 1048576); assert.equal(reply.result.text.includes('\uFFFD'), false, 'no split UTF-8 sequence in the test pipe');
    assert.match(reply.result.text, /The focused UI element is 1 button/);
  });
  await t.test('cooperative walk budget returns a healthy partial tree with final-check time left', async () => {
    const data = recordedFixture(excelTree); data.menu = undefined;
    data.trees['7'] = node('AXWindow', { children: [node('AXButton', { AXTitle: 'slow', delayMs: 80 })] });
    const reply = (await readFixture(data, [['getAXState', { ...binding, budgetMs: 40 }], ['ping', {}]])).replies;
    assert.equal(reply[0].ok, true); assert.equal(reply[0].result.truncated, true);
    assert.equal(reply[1].ok, true); assert.equal(elementLines(reply[0].result.text).size, 1);
  });
  await t.test('hard deadline retires a helper blocked in a fake provider', async () => {
    const blocked = { ...fixtureData, trees: { '7': node('AXWindow', { delayMs: 2000 }) } };
    const path = join(root, 'blocked.json'); await writeFile(path, JSON.stringify(blocked));
    const result = await run(JSON.stringify(envelope(1, 'getAXState', binding, { deadline: Date.now() + 500 })) + '\n', nonce, ['--fixture', path]);
    assert.equal(result.code, 70); assert.equal(result.replies.length, 1);
    assert.equal(result.replies[0].error.code, 'DEADLINE_EXCEEDED'); assert.equal(result.replies[0].error.unhealthy, true);
  });
  await t.test('queue time counts against the next request deadline', async () => {
    const blocked = { ...fixtureData, trees: { '7': node('AXWindow', { delayMs: 2000 }) } };
    const path = join(root, 'queued.json'); await writeFile(path, JSON.stringify(blocked));
    const lines = [envelope(1, 'getAXState', binding), envelope(2, 'ping', {}, { deadline: Date.now() + 500 })]
      .map(r => JSON.stringify(r) + '\n').join('');
    const result = await run(lines, nonce, ['--fixture', path]);
    assert.equal(result.code, 70); assert.equal(result.replies.length, 1); assert.equal(result.replies[0].id, 2);
    assert.equal(result.replies[0].error.code, 'DEADLINE_EXCEEDED');
  });
});
