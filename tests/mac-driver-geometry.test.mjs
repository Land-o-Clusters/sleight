import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createMacDriverClient } from '../plugins/sleight/lib/mac-driver/client.mjs';
import { DRIVER_CORE_METHODS } from '../plugins/sleight/lib/mac-driver/protocol.mjs';
import { createRuntimeActionEvents } from '../plugins/sleight/lib/mac-driver/action-events.mjs';
import { privateGlideObservation } from '../plugins/sleight/lib/mac-driver/geometry.mjs';
import { compileSwiftHelper } from '../bench/swift-cache.mjs';
import { macDriverSource } from '../plugins/sleight/lib/mac-driver/build.mjs';
import { harness } from './fixtures/glide-hand.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';

const nativeMutations = {
  'root-replacement': ['held.element.root.same(map.root), next.root.same(map.root)', 'true'],
  'same-label-replacement': ['let matches = index[DriverSettleNodeKey(node: held.element.node)] ?? []',
    'let matches = map.elements.values.filter { $0.label == held.element.label && $0.role == held.element.role }'],
  'absence-as-departure': ['let matches = index[DriverSettleNodeKey(node: held.element.node)] ?? []',
    'let matches = index[DriverSettleNodeKey(node: held.element.node)] ?? []; if matches.isEmpty { row["joined"] = true; row["semantic"] = true; row["clipping"] = true; row["departed"] = true }'],
  'map-eviction': ['if held.values.contains(where: { $0.window == window }) { failed = true }', 'if false { failed = true }'],
  'swift-clipping': ['let clipped = frame.intersection(bounds)', 'let clipped = frame'],
  'swift-duplicate-join': ['if matches.count == 1, let next = matches.first,', 'if !matches.isEmpty, let next = matches.first,'],
  'swift-window-root': ['!old.2.same(map.root)', 'false'],
  'swift-capacity': ['guard held.count < 512 else', 'guard held.count < 513 else'],
};

test('native retained-object adapter keeps identity, capacity and clipping without backend work',
  { skip: process.platform !== 'darwin', timeout: 900000 }, async t => {
    const root = trackTemp(await mkdtemp(join(await realpath(tmpdir()), 'sleight-glide-geometry-')));
    t.after(() => rm(root, { recursive: true, force: true }));
    let source = macDriverSource().replace(/\ndriverMain\(\)\s*$/, '\n');
    assert.ok(!source.endsWith('driverMain()\n'), 'windowless fixture replaces only the entry point');
    const begin = source.indexOf('final class DriverNode {'), end = source.indexOf('struct DriverBoundWindow');
    const node = source.slice(begin, end).replace(/(func (?:timeout|attributes|children|settable|secondaryActions|frame|pid|belongs)\([^\n]*\{)/g, '$1\n        gp2AX += 1');
    assert.equal((node.match(/gp2AX \+= 1/g) ?? []).length, 8, 'all AX accessor families instrumented');
    source = source.slice(0, begin) + node + source.slice(end);
    source = source.replace(/(func capture\([^\n]*\{)/g, '$1\n        gp2Captures += 1');
    const sleeps = (source.match(/Thread\.sleep\(/g) ?? []).length;
    source = source.replace(/Thread\.sleep\(/g, 'gp2Sleep(');
    source = 'var gp2AX = 0, gp2Captures = 0, gp2Waits = 0\n' +
      'func gp2Sleep(forTimeInterval seconds: Double) { gp2Waits += 1; Thread.sleep(forTimeInterval: seconds) }\n' + source;
    assert.ok(sleeps > 0, 'native sleep sites instrumented');
    const mutation = nativeMutations[process.env.GP2_NATIVE_VARIANT];
    if (mutation) {
      assert.equal(source.split(mutation[0]).length, 2, 'one native production mutation site');
      source = source.replace(...mutation);
    }
    const adapter = await readFile(new URL('../plugins/sleight/lib/mac-driver/native/DriverGeometry.swift', import.meta.url), 'utf8');
    assert.doesNotMatch(adapter, /AXUIElement(?:Copy|Get|Set|Create)|\.(?:attributes|children|settable|secondaryActions|frame|pid|capture)\(|Thread\.sleep|\.wait\(/);
    // Inject only the output descriptor. The compiled readTree, resolveElement,
    // reuse, eviction and publish call sites remain production source.
    source = source.replace('let geometry = DriverGeometryBank()', 'let geometry = DriverGeometryBank(pipe: gp2Pipe())');
    source += `
func gp2Pipe() -> DriverGeometryPipe {
    if CommandLine.arguments.contains("--geometry-protocol-selftest") { return .shared }
    return DriverGeometryPipe(descriptor: open("/dev/null", O_WRONLY), nonce: String(repeating: "f", count: 64))
}
`;
    source += `
if CommandLine.arguments.contains("--geometry-pipe-selftest") {
    DriverGeometryPipe.shared.send(["payload": String(repeating: "x", count: 200000)])
    _ = readLine()
} else if CommandLine.arguments.contains("--geometry-protocol-selftest") {
` + await readFile(new URL('./fixtures/glide-geometry-protocol.swift', import.meta.url), 'utf8') + `
} else {
` + await readFile(new URL('./fixtures/glide-geometry.swift', import.meta.url), 'utf8') + '\n}\n';
    const input = join(root, 'geometry.swift'); await writeFile(input, source);
    // The repository helper owns compilation and uses its shared module cache.
    const binary = await compileSwiftHelper(input, { timeoutMs: 900000 });
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 1048576 });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    const rows = run.stdout.trim().split('\n').map(JSON.parse), byName = Object.fromEntries(rows.map(r => [r.case, r]));
    const refusalCases = { 'root-replacement': 'root', 'same-label-replacement': 'proxy',
      'absence-as-departure': 'missing', 'map-eviction': 'eviction' };
    for (const [variant, name] of Object.entries(refusalCases)) {
      if (process.env.GP2_NATIVE_VARIANT && process.env.GP2_NATIVE_VARIANT !== variant) continue;
      const parent = await harness(t); parent.act(); parent.wire.begin(3);
      parent.send(3, { ...byName[name], read: 2 });
      assert.equal(parent.certificates().length, 1, `${variant}: native refusal must not produce a GP1 certificate`);
    }
    assert.equal(byName.baseline.references.length, 0);
    assert.equal(byName.positive.references[0].joined, true, 'number 900 joins number 1 only by proxy');
    assert.deepEqual(byName.positive.references[0].rects, [[-200, 120, 41, 21]]);
    assert.equal(byName.missing.references[0].joined, false, 'a missing object cannot be certified as departed');
    for (const name of ['proxy', 'root', 'process', 'missing']) assert.equal(byName[name].references[0].joined, false, name);
    assert.equal(byName.recycled.references[0].semantic, false);
    assert.equal(byName.partial.complete, false); assert.equal(byName.notifications.notifications, false);
    assert.equal(byName.departed.references[0].joined, true); assert.equal(byName.departed.references[0].departed, true);
    assert.equal(byName.eviction.continuous, false);
    assert.deepEqual(byName.capacity, { case: 'capacity', held: 512, failed: true });
    assert.deepEqual(byName['next-turn'], { case: 'next-turn', held: 0, failed: false });
    assert.deepEqual(byName.instrumentation, { case: 'instrumentation', ax: 0, captures: 0, inputWaits: 0 });
    assert.equal(byName['read-tap'].complete, true);
    assert.equal(byName['read-tap'].settled, true);
    assert.equal(byName['read-tap'].notifications, true);
    assert.equal(byName['read-reuse'].reused, true);
    assert.equal(byName['read-reuse'].start, byName['read-reuse'].originalStart);
    assert.equal(byName['read-reuse'].end, byName['read-reuse'].originalEnd);
    assert.ok(byName['resolve-tap'].references.some(r => r.action === 4 && r.joined), 'request id is retained by real resolveElement');
    assert.equal(byName['drag-tap'].drag, true);
    assert.equal(byName['window-root-change'].continuous, false);
    assert.equal(byName['duplicate-join'].references[0].joined, false);
    assert.ok(byName['tap-instrumentation'].off.ax > 0, 'read and resolve work is counted');
    assert.deepEqual(byName['tap-instrumentation'].on, byName['tap-instrumentation'].off);
    assert.equal(byName['tap-instrumentation'].addedAX, 0);
    assert.equal(byName['tap-instrumentation'].on.captures, 0);
    assert.equal(byName['tap-instrumentation'].on.inputWaits, 0);
    for (const count of [500, 3000]) for (const refs of [0, 64]) {
      const cost = byName[`cost-${count}-${refs}`]; assert.equal(cost.elements, count); assert.equal(cost.references, refs);
      assert.equal(cost.iterations, 100); assert.ok(cost.cpuMs > 0); assert.ok(cost.elapsedMs > 0);
      t.diagnostic(JSON.stringify(cost));
    }
    t.diagnostic(JSON.stringify(byName['tap-instrumentation']));
    const pipeChild = spawn(binary, ['--geometry-pipe-selftest'], { env: { ...process.env, SLEIGHT_DRIVER_GEOMETRY: '1', SLEIGHT_DRIVER_NONCE: 'f'.repeat(64) }, stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] });
    pipeChild.stdout.resume(); pipeChild.stderr.resume();
    const pipeDeadline = setTimeout(() => pipeChild.stdin.end(), 5000);
    t.after(() => { clearTimeout(pipeDeadline); pipeChild.stdin.end(); });
    pipeChild.stdio[4].on('end', () => pipeChild.stdin.end());
    let message = '';
    pipeChild.stdio[4].on('data', bytes => {
      message += bytes;
      if (message.endsWith('\n')) pipeChild.stdin.end('done\n');
    });
    const [code] = await once(pipeChild, 'close'); clearTimeout(pipeDeadline);
    assert.equal(code, 0); assert.equal(JSON.parse(message).payload.length, 200000);
    assert.ok(Buffer.byteLength(message) <= 262144, 'large map uses one bounded asynchronous slot');
    t.diagnostic(`privatePipeBytes=${Buffer.byteLength(message)} completeRecords=1`);
    // Real inherited fd 4 and the actual stdin reader, not a copied parser.
    const child = spawn(binary, ['--geometry-protocol-selftest'], { env: { ...process.env, SLEIGHT_DRIVER_GEOMETRY: '1', SLEIGHT_DRIVER_NONCE: 'f'.repeat(64) },
      stdio: ['pipe', 'pipe', 'pipe', 'ignore', 'pipe'] });
    child.stderr.resume();
    const replies = new Map(), records = [], waits = new Map(); let stdout = '', metadata = '', next = 0;
    const deadline = setTimeout(() => child.stdin.end(), 10000);
    t.after(() => { clearTimeout(deadline); child.stdin.end(); });
    child.stdout.on('data', bytes => {
      stdout += bytes;
      for (let at; (at = stdout.indexOf('\n')) >= 0;) {
        const reply = JSON.parse(stdout.slice(0, at)); stdout = stdout.slice(at + 1);
        replies.set(reply.id, reply); waits.get(reply.id)?.(); waits.delete(reply.id);
      }
    });
    child.stdio[4].on('data', bytes => {
      metadata += bytes;
      for (let at; (at = metadata.indexOf('\n')) >= 0;) {
        records.push(JSON.parse(metadata.slice(0, at))); metadata = metadata.slice(at + 1);
      }
    });
    const token = 'b'.repeat(32);
    const request = async (method, params, geometryTurn = token) => {
      const id = ++next;
      const ready = new Promise(resolve => waits.set(id, resolve));
      child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'f'.repeat(64), id, method, params,
        deadline: Date.now() + 5000, ...geometryTurn ? { geometryTurn } : {} }) + '\n');
      await ready; assert.equal(replies.get(id).ok, true, JSON.stringify(replies.get(id))); return replies.get(id).result;
    };
    const binding = { windowId: '7', processStart: 'start', reuseIfUnchanged: 0 };
    const first = await request('getAXState', binding);
    await request('click', { windowId: '7', processStart: 'start', readId: first.readId, args: [1] });
    await request('getAXState', { ...binding, reuseIfUnchanged: first.readId });
    await request('getAXState', binding);
    await request('drag', { windowId: '7', processStart: 'start', readId: first.readId + 1, args: [1] });
    await request('getAXState', binding);
    for (let id = 8; id <= 23; id++) await request('getAXState', { ...binding, windowId: String(id) });
    const evicted = await request('health', {}, undefined);
    assert.equal(evicted.held, 2); assert.equal(evicted.failed, true, 'seventeenth window evicts a held read map');
    child.stdin.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'f'.repeat(64), control: 'geometry-end', turn: token }) + '\n');
    const ended = await request('health', {}, null);
    assert.deepEqual(ended, { held: 0, failed: false, turn: null });
    const fresh = await request('getAXState', binding, 'c'.repeat(32));
    assert.ok(fresh.readId > first.readId);
    child.stdin.end(); const [readerCode] = await once(child, 'close'); clearTimeout(deadline);
    assert.equal(readerCode, 0); assert.equal(metadata, '');
    assert.equal(records[0].references.length, 0);
    assert.equal(records[1].reused, true);
    assert.equal(records[1].references[0].action, 2);
    assert.deepEqual(records[1].acquired, records[0].acquired);
    assert.equal(records[2].references[0].joined, true);
    assert.equal(records[3].drag, true);
    assert.equal(records.at(-2).continuous, false);
    assert.equal(records.at(-1).turn, 'c'.repeat(32)); assert.equal(records.at(-1).references.length, 0);
    for (const [name, patch] of [['wrong-nonce', { nonce: '0'.repeat(64) }], ['extra-key', { extra: true }], ['bad-token', { turn: 'x'.repeat(32) }]]) {
      const control = { protocol: 'sleight.driver/1', platform: 'darwin', nonce: 'f'.repeat(64), control: 'geometry-end', turn: token, ...patch };
      const invalid = spawnSync(binary, ['--geometry-protocol-selftest'], { input: JSON.stringify(control) + '\n', encoding: 'utf8',
        timeout: 10000, killSignal: 'SIGKILL' });
      assert.equal(invalid.status, 65, name);
    }
    const badTurn = spawnSync(binary, ['--geometry-protocol-selftest'], { input: JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin',
      nonce: 'f'.repeat(64), id: 1, method: 'health', params: {}, deadline: Date.now() + 5000, geometryTurn: 'x'.repeat(32) }) + '\n',
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
    assert.equal(badTurn.status, 65);
    t.diagnostic(`productionReaderObservations=${records.length} invalidPrivateFrames=4 resolveAction=2 dragAction=5`);
    const hand = await harness(t);
    // Feed actual Swift output into the inherited pipe parser and real GP1
    // transport. Parent request intervals enclose the saved native interval.
    hand.act(); hand.wire.begin(3);
    hand.send(3, records[2]);
    assert.equal(hand.certificates().length, 2, 'native full map reaches GP1 certify');
    t.diagnostic(JSON.stringify(byName.overhead));
    t.diagnostic(`nativeFixtureCases=${rows.length} axAccessorFamilies=8 addedAX=0 captures=0 inputWaits=0`);
  });

test('driver owns a separate inherited geometry channel and idle cleanup retains its logical turn', async t => {
  const feed = createRuntimeActionEvents(), observed = [], controls = [], spawnOptions = [];
  feed.connect(() => {}); feed.connectGeometry(r => observed.push(privateGlideObservation(r)));
  const driver = createMacDriverClient({ platform: 'darwin', actionEvents: feed, prepare: async () => ({ status: 'ready', build: 'b'.repeat(64), spawn(options) {
    spawnOptions.push(options);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const q = JSON.parse(bytes.toString()); done();
      if (q.control) { controls.push(q); return; }
      const result = q.method === 'ping' ? { protocol: 'sleight.driver/1', apiVersion: 2, build: 'b'.repeat(64), methods: DRIVER_CORE_METHODS } : {};
      queueMicrotask(() => child.stdout.write(JSON.stringify({ protocol: 'sleight.driver/1', platform: 'darwin', nonce: q.nonce, id: q.id, ok: true, result }) + '\n'));
    } });
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough(), new PassThrough()];
    child.kill = () => { queueMicrotask(() => child.emit('close', 0, null)); return true; };
    return child;
  } }) });
  t.after(async () => { await driver.close(); feed.close(); });
  await driver.ping(); assert.equal(spawnOptions[0].geometryEvents, true); assert.equal(spawnOptions[0].actionEvents, true);
  assert.equal(observed.filter(r => r.type === 'begin').length, 0, 'ping never opens a producer turn');
  await driver.request('getAXState', {});
  assert.equal(observed.filter(r => r.type === 'begin').length, 1);
  driver.endTurn(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(controls.length, 0, 'lease/idle cleanup never releases retained objects');
  driver.endGeometryTurn(); assert.equal(controls[0].control, 'geometry-end');
  assert.equal(observed.at(-1).type, 'end');
  await driver.ping(); assert.equal(observed.filter(r => r.type === 'begin').length, 1);
  await driver.request('getAXState', {}); assert.equal(observed.filter(r => r.type === 'begin').length, 2);
  assert.notEqual(observed[0].turn, observed.at(-1).turn);
});
