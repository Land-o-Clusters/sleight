import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { calculatorTree, excelTree, recordedFixture } from './fixtures/mac-driver-recorded-tree.mjs';

const native = new URL('../plugins/sleight/lib/mac-driver/native/', import.meta.url);
test('recorded fixture tree geometry census reports synthetic frames as diagnostics', t => {
  let trees = 0, nodes = 0, frameless = 0;
  for (const [name, text] of [['Calculator', calculatorTree], ['Excel', excelTree]]) {
    let count = 0, missing = 0;
    const visit = node => {
      count++;
      if (!node.frame) missing++;
      for (const child of node.children ?? []) visit(child);
    };
    for (const root of Object.values(recordedFixture(text).trees)) { trees++; visit(root); }
    t.diagnostic(`${name}: nodes=${count}, frameless=${missing}; recordedFixture supplies synthetic geometry`);
    nodes += count; frameless += missing;
  }
  t.diagnostic(`recorded trees=${trees}, nodes=${nodes}, frameless=${frameless}; live prevalence is unmeasured`);
});

async function run(command, args, input, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('RT26 settle and person rules with fake providers only', { skip: process.platform !== 'darwin', timeout: 300000 }, async t => {
  assert.ok(existsSync(new URL('DriverSettle.swift', native)), 'RT26 settle implementation is missing');
  assert.ok(existsSync(new URL('DriverPerson.swift', native)), 'RT26 person implementation is missing');
  const root = trackTemp(await mkdtemp(join(tmpdir(), 'sleight-rt26-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'rules.swift'), binary = join(root, 'rules');
  const installed = macDriverSource();
  const composed = process.env.GL1_NATIVE_MUTANT === 'disabled'
    ? installed.replace('let driverInputGateEnabled = true', 'let driverInputGateEnabled = false') : installed;
  const entry = composed.indexOf('// Source: DriverMain.swift\n');
  assert.ok(entry > 0);
  // Compile the real entry point too. It runs only with an in-memory fixture;
  // the default mode below executes the fake-provider rules.
  const fixtureMode = '\nif CommandLine.arguments.dropFirst().first == "--fixture" { driverMain() }\n';
  // Mutate only the in-memory tree after the before-action read. No event sink.
  const fixtureAction = `
    runtime.register(method: "fixturePointerTimeout") { _, _ in
      do {
        let _: Int = try DriverPointer.fromCore {
          try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: { _ in }, read: { 321 })
        }
        return [:]
      } catch let failure as DriverPointerFault {
        var error = DriverFault(failure.code, failure.message, unhealthy: failure.unhealthy)
        error.disposition = failure.json; throw error
      }
    }
    let keyboard = DriverKeyboard(layout: { [:] }, makeEvent: { _ in { _ in
      fatalError("person timeout must refuse before the fake event sink")
    } }, ladder: { "flags-changed" }, pause: {}, beforeInput: { _, _ in
      _ = try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: { _ in }, read: { 321 })
    })
    keyboard.register(in: runtime, fault: { failure in
      var error = DriverFault(failure.code, unhealthy: failure.unhealthy)
      error.disposition = failure.json; return error
    })
    runtime.register(method: "fixturePersonTimeout") { _, _ in
      _ = try DriverPersonProviders.frontmostPID(isMainThread: false, enqueue: { _ in }, read: { 321 })
      return [:]
    }
    if let trees = core.inventory.fixture?["trees"] as? NSMutableDictionary {
      runtime.register(method: "fixtureChange") { _, _ in
        let changed = NSMutableDictionary(dictionary: trees["42"] as! DriverObject)
        changed["AXTitle"] = "after"; trees["42"] = changed
        return [:]
      }
    }
  `;
  const fixtureSource = composed.replace('if let forbidden = fake["forbidReads"]',
    'if names.contains("AXHidden"), let code = fake["digestFault"] as? String { throw DriverFault(code) }\n            if let forbidden = fake["forbidReads"]')
    .replace('func frame(_ request: DriverRequest, cached: DriverObject? = nil) throws -> CGRect {',
      'func frame(_ request: DriverRequest, cached: DriverObject? = nil) throws -> CGRect {\n        if let delay = fake?["frameDelayMs"] as? Int { Thread.sleep(forTimeInterval: Double(delay) / 1000); try timeout(request) }\n        if let code = fake?["frameFault"] as? String { throw DriverFault(code) }')
    .replace('let children = fake["children"] as? [DriverObject] ?? []',
      'if let delay = fake["digestChildrenDelayMs"] as? Int { Thread.sleep(forTimeInterval: Double(delay) / 1000) }\n            let children = fake["children"] as? [DriverObject] ?? []')
    .replace('var methods: [String]', 'func fixtureInvoke(_ request: DriverRequest) throws -> DriverObject { try handlers[request.method]!(request, core) }\n    var methods: [String]')
    .replace('let core = DriverCore(fixture: fixture), runtime =',
    'if let trees = fixture?["trees"] as? DriverObject { fixture?["trees"] = NSMutableDictionary(dictionary: trees) }\n    let core = DriverCore(fixture: fixture), runtime =')
    .replace('runtime.install(driverRegistrars)', 'runtime.install(driverRegistrars)\n' + fixtureAction);
  await writeFile(source, fixtureSource.replace(/\ndriverMain\(\)\s*$/, '\n') + fixtureMode +
    await readFile(new URL('./fixtures/mac-driver-settle-person.swift', import.meta.url), 'utf8'));
  const build = await run('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES', '-module-cache-path', join(root, 'modules'), source, '-o', binary]);
  assert.equal(build.code, 0, build.stderr);
  t.diagnostic(`swiftc exit=${build.code}, binaryBytes=${(await stat(binary)).size}`);
  const result = await run('/usr/bin/nice', ['-n', '20', binary]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const rows = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.length >= 40, `expected rules and timeout coverage, got ${rows.length}`);
  for (const row of rows) await t.test(row.name, () => assert.equal(row.pass, true, JSON.stringify(row)));
  const frame = { x: 0, y: 0, width: 100, height: 100 };
  const binding = { windowId: '42', processStart: 'start' }, fixture = join(root, 'inventory.json');
  await writeFile(fixture, JSON.stringify({
    apps: [{ id: 'test.settle', name: 'Fixture', pid: 321, processStart: 'start' }],
    windows: ['42', '43'].map(windowId => ({ ...binding, windowId, pid: 321, bounds: frame, onScreen: true, layer: 0, hidden: false })),
    trees: Object.fromEntries(['42', '43'].map(id => [id, { AXRole: 'AXWindow', AXMain: true,
      AXMinimized: false, AXFullScreen: false, pid: 321, frame, children: [] }])),
  }));
  const nonce = 'a'.repeat(64);
  const calls = [['ping', {}], ['personState', binding], ['getAXState', binding],
    ['settle', { ...binding, afterReadId: 1, waitForWindow: true, capMs: 20 }],
    ['settle', { ...binding, waitForWindow: true }],
    ['settle', { ...binding, afterReadId: 999 }],
    ['settle', { ...binding, includeScroll: 1 }], ['getAXState', binding], ['getAXState', binding],
    ['fixtureChange', {}], ['settle', { ...binding, afterReadId: 3 }],
    ['fixturePersonTimeout', {}], ['ping', {}], ['getAXState', binding], ['fixturePointerTimeout', {}],
    ['pressKey', { ...binding, readId: 4, args: ['Return'], read: 'none' }]];
  const lines = calls.map(([method, params], i) => JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
    nonce, id: i + 1, method, params, deadline: Date.now() + 5000 })).join('\n') + '\n';
  const protocol = await run('/usr/bin/nice', ['-n', '20', binary, '--fixture', fixture], lines,
    { ...process.env, SLEIGHT_DRIVER_NONCE: nonce });
  assert.equal(protocol.code, 0, protocol.stderr); assert.equal(protocol.stderr, '');
  const replies = protocol.stdout.trim().split('\n').map(line => JSON.parse(line));
  await t.test('installed registrar advertises settle, person state and pointer input', () => {
    assert.ok(replies[0].result.methods.includes('settle'));
    assert.ok(replies[0].result.methods.includes('personState'));
    assert.ok(replies[0].result.methods.includes('click'));
  });
  await t.test('fixture person state returns a token without host sampling', () => {
    assert.equal(replies[1].result.personTookOver, false); assert.equal(typeof replies[1].result.token, 'string');
  });
  await t.test('existing secondary window cannot satisfy primary wait through real stdin', () => {
    assert.equal(replies[3].result.settled, false); assert.equal(replies[3].result.reason, 'cap');
  });
  await t.test('primary wait needs a retained before-action read', () => assert.equal(replies[4].error.code, 'INVALID_PARAMS'));
  await t.test('stale read refuses settle', () => assert.equal(replies[5].error.code, 'STALE_READ'));
  await t.test('malformed scroll flag refuses before observation', () => assert.equal(replies[6].error.code, 'INVALID_PARAMS'));
  await t.test('settle digest polls preserve retained read numbering', () => {
    assert.equal(replies[2].result.readId, 1); assert.equal(replies[7].result.readId, 2);
  });
  await t.test('production settle sees a completed fixture action without a capture grant', () => {
    assert.equal(replies[10].ok, true, JSON.stringify(replies[10]));
    assert.equal(replies[10].result.reason, 'quiet');
    assert.equal(replies[10].result.digestComplete, true);
    assert.equal(replies[10].result.observer, false);
  });
  await t.test('consecutive idle reads skip settle without a capture grant', () => {
    assert.equal(replies[7].ok, true); assert.equal(replies[8].ok, true); assert.equal(replies[8].result.readId, 3);
  });
  await t.test('frontmost timeout refuses one request and preserves helper read maps through stdin', () => {
    assert.equal(replies[11].ok, false);
    assert.equal(replies[11].error.unhealthy, false);
    assert.equal(replies[11].error.reason, 'person-unknown');
    assert.equal(replies[11].error.personTookOver, false);
    assert.equal(replies[12].ok, true);
    assert.equal(replies[13].result.readId, 4);
  });
  for (const [index, label] of [[14, 'pointer'], [15, 'keyboard']]) {
    await t.test(`${label} person timeout preserves reason and no-takeover flag in the protocol reply`, () => {
      assert.equal(replies[index].ok, false);
      assert.equal(replies[index].error.code, 'PERSON_TOOK_OVER');
      assert.equal(replies[index].error.reason, 'person-unknown');
      assert.equal(replies[index].error.personTookOver, false);
      assert.equal(replies[index].error.delivery, 'not-sent');
      assert.equal(replies[index].error.retry, 'safe');
      assert.equal(replies[index].error.unhealthy, false);
    });
  }
});
