import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { productModule } from './fixtures/runtime-helper-inspection.mjs';

const window = { windowId: '42', pid: 42, processStart: '1.0', bundleId: 'test.reuse',
  app: 'Fixture', title: 'Fixture', identityVerified: true };
const text = 'Window: "Fixture", App: Fixture.\n0 standard window Fixture\n\t1 button OK';
const row = (readId, patch = {}) => ({ window, text, readId, truncated: false, ...patch });
const click = readId => ({ ...window, readId, args: [1] });

test('reused read preserves delivered authority but never creates or revives it', () => {
  const reads = createMacReadState();
  const first = reads.read(row(1));
  reads.endCell([{ type: 'text', text }], [first]);
  assert.doesNotThrow(() => reads.read(row(1, { reused: true })));
  assert.doesNotThrow(() => reads.assertCurrent('click', click(1), 'cell'));
  reads.endTurn();
  reads.read(row(1, { reused: true }));
  assert.throws(() => reads.assertCurrent('click', click(1), 'next'), { code: 'STALE_READ' });
  reads.reset();
  assert.throws(() => reads.read(row(1, { reused: true })), { code: 'DRIVER_PROTOCOL' });
});

test('reuse marker cannot excuse changed text, truncation or read id', () => {
  for (const patch of [{ text: text + '\n\t2 button Other' }, { truncated: true }, { readId: 2 }, { reused: 'true' }]) {
    const reads = createMacReadState(); reads.read(row(1));
    assert.throws(() => reads.read(row(1, { reused: true, ...patch })), { code: 'DRIVER_PROTOCOL' });
  }
});

test('reuse observer registers off the main thread with bounded AX messaging', () => {
  const source = readFileSync(new URL('../plugins/sleight/lib/mac-driver/native/DriverSettle.swift', import.meta.url), 'utf8');
  const observation = source.slice(source.indexOf('final class DriverReadObservation'), source.indexOf('struct DriverReadReuse'));
  assert.doesNotMatch(observation, /DispatchQueue\.main\.sync/);
  assert.match(observation, /queue\.async/);
  assert.match(observation, /observer\.start\(bound, deadline: deadline, attach: false\)/);
  assert.match(source, /AXUIElementSetMessagingTimeout\(element, Float\(min\(0\.01, remaining\)\)\)/);
});

test('negative control: preserving old-turn delivery revives stale numbers', async t => {
  const broken = await productModule('mac-driver/diff.mjs', source => {
    for (const anchor of ['entry.delivered = undefined;', 'entry.belief = undefined;']) assert.ok(source.includes(anchor));
    return source.replace('entry.delivered = undefined;', '/* broken: old delivery survives */')
      .replace('entry.belief = undefined;', '/* broken: old belief survives */');
  });
  const reads = broken.createMacReadState(); const first = reads.read(row(1));
  reads.endCell([{ type: 'text', text }], [first]); reads.endTurn();
  reads.read(row(1, { reused: true }));
  assert.doesNotThrow(() => reads.assertCurrent('click', click(1), 'next'));
  t.diagnostic('broken variant=old-turn-delivery: old-turn refusal assertion fails');
});

test('native read reuse rules, fake accessibility and observer only', { skip: process.platform !== 'darwin', timeout: 720000 }, t => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-read-reuse-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'reuse.swift'), binary = join(root, 'reuse');
  let composed = macDriverSource().replace(/\ndriverMain\(\)\s*$/, '\n');
  const replace = (from, to) => {
    assert.equal(composed.split(from).length, 2, `mutation anchor: ${from}`);
    composed = composed.replace(from, to);
  };
  // Faults, callbacks and broken guards exist only in this temporary executable.
  replace('if let fake = fake {\n            // Only', `if let fake = fake {
            if let key = fake["key"] as? String, reuseDeadKeys.contains(key) { throw DriverFault("STALE_ELEMENT") }
            if names.contains("AXHidden") {
                reuseOnAttributes?()
                if let ms = fake["digestDelayMs"] as? Int { Thread.sleep(forTimeInterval: Double(ms) / 1000) }
                if let code = fake["digestFault"] as? String { throw DriverFault(code) }
            }
            // Only`);
  replace('var result = fake.filter { names.contains($0.key) }', `var result = fake.filter { names.contains($0.key) }
            if reuseTransientLabel && fake["key"] as? String == "ok" && names.count > 2 && names[1] == "AXDescription" {
                result["AXTitle"] = "Transient"
            }`);
  replace('func attributes(_ names: [String], request: DriverRequest, strict: Bool = false) throws -> DriverObject {',
    `func attributes(_ names: [String], request: DriverRequest, strict: Bool = false) throws -> DriverObject {
        if fake != nil && reuseTrace { reuseOperations.append("attributes:" + names.joined(separator: ",")) }`);
  replace('func frame(_ request: DriverRequest, cached: DriverObject? = nil) throws -> CGRect {', `func frame(_ request: DriverRequest, cached: DriverObject? = nil) throws -> CGRect {
        if fake != nil { if reuseTrace { reuseOperations.append("frame") }; reuseOnFrame?(request) }`);
  replace('func children(_ request: DriverRequest, limit: Int, cached: Any? = nil) throws -> ([DriverNode], Bool) {',
    `func children(_ request: DriverRequest, limit: Int, cached: Any? = nil) throws -> ([DriverNode], Bool) {
        if reuseTrace { reuseOperations.append("children") }`);
  replace('return DriverSettleTree(digest: count', 'if forReuse && reuseForcePartial { complete = false }\n        return DriverSettleTree(digest: count');
  replace('before == revision && after == revision',
    '(reuseMutation == "revision-stored" || before == revision) && (["revision-stored", "revision-after"].contains(reuseMutation) || after == revision)');
  replace('tree?.complete == true && tree?.faulted == false && tree?.digest == digest',
    '(reuseMutation == "partial" || tree?.complete == true) && tree?.faulted == false && (reuseMutation == "digest" || tree?.digest == digest)');
  replace('before: Int, after: Int) -> Bool {\n        ',
    'before: Int, after: Int) -> Bool {\n        if reuseMutation == "fault" { return true }\n        return ');
  replace('let observation = !reuseEnabled', 'var observation = !reuseEnabled');
  replace('let observer = observation.observer', `if reuseRegistrationTimeout {
            observation = DriverReadObservation.register(deadline: ProcessInfo.processInfo.systemUptime + 0.001,
                enqueue: { _ in }, create: { DriverReadObservation(sample: { 0 }) })
        }
        let observer = observation.observer ?? (reuseEnabled && reuseMutation == "observer" ? DriverReadObservation(sample: { 0 }) : nil)`);
  replace('ready.wait(timeout: .now() + max(0, deadline - ProcessInfo.processInfo.systemUptime))',
    'ready.wait(timeout: .now() + (reuseMutation == "registration-wait" ? 0.2 : max(0, deadline - ProcessInfo.processInfo.systemUptime)))');
  replace('if !expired && ProcessInfo.processInfo.systemUptime < deadline { observer = value }',
    'if !expired && (reuseMutation == "registration-late" || ProcessInfo.processInfo.systemUptime < deadline) { observer = value }');
  replace('if observation.timedOut { result["diagnostics"] = ["readReuse": "observer-timeout"] }',
    'if observation.timedOut && reuseMutation != "registration-diagnostics" { result["diagnostics"] = ["readReuse": "observer-timeout"] }');
  replace('if forReuse { complete = false }; return', 'if forReuse && reuseMutation != "secure" { complete = false }; return');
  replace('if forReuse && (driverDocumentRoot(role, subrole) || role == "AXCanvas") { complete = false; return }',
    'if forReuse && (driverDocumentRoot(role, subrole) || role == "AXCanvas") { if reuseMutation != "document" { complete = false }; return }');
  for (const name of ['bound', 'current']) replace(`driverRect(${name}.window["bounds"]) == proof.bounds`,
    `(reuseMutation == "bounds-${name}" || driverRect(${name}.window["bounds"]) == proof.bounds)`);
  replace('retained.processStart == bound.window["processStart"] as? String',
    '(reuseMutation == "process-start" || retained.processStart == bound.window["processStart"] as? String)');
  replace('retained.root.same(bound.root), !retained.truncated,',
    '(reuseMutation == "root" || retained.root.same(bound.root)), (reuseMutation == "truncated" || !retained.truncated),');
  for (const name of ['bound', 'current']) {
    replace(`retained.windowIDs == inventory.observedWindowIDs(${name}.window).union([id])`,
      `(reuseMutation == "inventory-${name}" || retained.windowIDs == inventory.observedWindowIDs(${name}.window).union([id]))`);
    replace(`(proof.result["window"] as? DriverObject)?["app"] as? String == ${name}.window["app"] as? String`,
      `(reuseMutation == "app-${name}" || (proof.result["window"] as? DriverObject)?["app"] as? String == ${name}.window["app"] as? String)`);
  }
  replace('let current = try? boundWindow(params, request: request)',
    'let current = reuseMutation == "second-bind" ? bound : try? boundWindow(params, request: request)');
  replace('current.root.same(retained.root),', '(reuseMutation == "current-root" || current.root.same(retained.root)),');
  replace('role == proof.rootRole, frame == proof.rootFrame,',
    '(reuseMutation == "root-role" || role == proof.rootRole), (reuseMutation == "root-frame" || frame == proof.rootFrame),');
  replace('if forReuse, node.pid() != root.pid()', 'if forReuse && reuseMutation != "foreign-pid", node.pid() != root.pid()');
  replace('if forReuse, let menu = menu { feed("menu-root"); try walk(menu, depth: 0, hidden: false) }',
    'if forReuse, let menu = menu, reuseMutation != "menu" { feed("menu-root"); try walk(menu, depth: 0, hidden: false) }');
  // GP2 records the final revision for geometry without removing the seed fence.
  replace('return finalRevision == revision }() {',
    'return reuseMutation == "seed-revision" || finalRevision == revision }() {');
  replace('for key in driverReuseLineKeys + driverReuseExtraKeys { driverReuseHash(attributes[key], into: &hash) }',
    'for key in driverReuseLineKeys + driverReuseExtraKeys where reuseMutation != "field-" + key { driverReuseHash(attributes[key], into: &hash) }');
  replace('driverReuseHash(role, into: &hash); driverReuseHash(subrole, into: &hash)',
    'if reuseMutation != "field-role" { driverReuseHash(role, into: &hash) }; if reuseMutation != "field-subrole" { driverReuseHash(subrole, into: &hash) }');
  replace('driverReuseHash(valueSettable, into: &hash); driverReuseHash(selectedSettable, into: &hash)',
    'if reuseMutation != "field-settable" { driverReuseHash(valueSettable, into: &hash) }; if reuseMutation != "field-selectable" { driverReuseHash(selectedSettable, into: &hash) }');
  replace('if !["AXMenuItem", "AXMenuBarItem"].contains(role) {',
    'if reuseMutation != "field-actions" && !["AXMenuItem", "AXMenuBarItem"].contains(role) {');
  replace('if let frame = frame { for n in [frame.minX, frame.minY, frame.width, frame.height] { driverReuseHash(n, into: &hash) } }',
    'if let frame = frame { for (index, n) in [frame.minX, frame.minY, frame.width, frame.height].enumerated() where reuseMutation != "field-frame-" + String(index) { driverReuseHash(n, into: &hash) } }');
  replace('driverReuseHash(children, into: &hash)', 'if reuseMutation != "field-children" { driverReuseHash(children, into: &hash) }');
  replace('driverInteger(params["reuseIfUnchanged"]) == retained.id',
    '(reuseMutation == "read-id" || driverInteger(params["reuseIfUnchanged"]) == retained.id)');
  replace('renderedDigest == hash,', '(reuseMutation == "walk-fingerprint" || renderedDigest == hash),');
  replace('let freshRole = try element.node.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String',
    'let freshRole = try (reuseMutation == "retained-object" ? element.role : element.node.attributes([kAXRoleAttribute], request: request)[kAXRoleAttribute] as? String)');
  writeFileSync(source, composed +
    readFileSync(new URL('fixtures/mac-driver-read-reuse.swift', import.meta.url), 'utf8'));
  const build = spawnSync('/usr/bin/nice', ['-n', '20', '/usr/bin/xcrun', 'swiftc', '-D', 'SLEIGHT_DRIVER_FIXTURES',
    '-module-cache-path', join(root, 'modules'), source, '-o', binary],
  { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assert.equal(build.status, 0, build.stderr);
  const run = spawnSync('/usr/bin/nice', ['-n', '20', binary],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const rows = run.stdout.trim().split('\n').map(line => JSON.parse(line));
  t.diagnostic(`native cases=${rows.length}, binaryBytes=${readFileSync(binary).length}`);
  for (const row of rows) assert.equal(row.pass, true, row.name);
  for (const [variant, witness] of [['revision-stored', 'sheet notification'], ['revision-after', 'notification during digest'],
    ['partial', 'partial digest'], ['digest', 'typing without notification'], ['observer', 'missing observer'],
    ['secure', 'secure digest alone never certifies'], ['document', 'document digest alone never certifies'],
    ['bounds-bound', 'resize before digest'], ['bounds-current', 'resize during digest'],
    ['process-start', 'retained process start changed'], ['root', 'root replaced between reads'],
    ['truncated', 'retained truncation'], ['app-bound', 'app header before digest'], ['app-current', 'app header during digest'],
    ['inventory-bound', 'window inventory before digest'], ['inventory-current', 'window inventory during digest'],
    ['second-bind', 'root replaced during digest'], ['current-root', 'root replaced during digest'],
    ['root-role', 'root role proof changed'], ['root-frame', 'root frame proof changed'],
    ['foreign-pid', 'foreign process digest alone never certifies'], ['menu', 'menu root changes the digest'],
    ['seed-revision', 'notification at seed end'],
    ['registration-wait', 'registration returns before queued work'],
    ['registration-late', 'late completion is not retained'],
    ['registration-diagnostics', 'registration timeout walks and reports diagnostics'],
    ['fault', 'digest fault'], ['retained-object', 'replacement stale retained object'], ['read-id', 'wrong read id walks'],
    ['walk-fingerprint', 'rendered transient cannot certify'],
    ...Object.entries({ AXTitle: 'title', AXValue: 'typing without notification', AXDescription: 'description',
      AXEnabled: 'enabled', AXFocused: 'focused', AXSelected: 'selected', AXElementBusy: 'busy',
      AXIdentifier: 'identifier', AXHelp: 'help', AXURL: 'url', AXDocument: 'document', AXExpanded: 'expanded',
      AXPlaceholderValue: 'placeholder', AXSelectedText: 'selection', AXDetails: 'details',
      role: 'role', subrole: 'subrole', settable: 'settable', selectable: 'selectable', actions: 'secondary actions',
      'frame-0': 'position', 'frame-1': 'position y', 'frame-2': 'size', 'frame-3': 'height', children: 'child count digest',
    }).map(([field, witness]) => [`field-${field}`, witness])]) {
    const broken = spawnSync('/usr/bin/nice', ['-n', '20', binary],
      { env: { ...process.env, UC2_MUTANT: variant }, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
    assert.equal(broken.status, 1, `${variant}: ${broken.stderr}`);
    const failed = broken.stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => !row.pass);
    assert.ok(failed.some(row => row.name === witness), `${variant}: missing witness ${witness}`);
    t.diagnostic(`broken variant=${variant}, failed assertions=${failed.length}, witness=${witness}`);
  }
});
