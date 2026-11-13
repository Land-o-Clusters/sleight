import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { acquireLiveLock } from '../bench/live-lock.mjs';
import * as runtime from '../bench/runtime-owner-away.mjs';

const runtimeURL = new URL('../bench/runtime-owner-away.mjs', import.meta.url);
const runtimeSource = readFileSync(runtimeURL, 'utf8');
async function variant(before, after) {
  assert.ok(runtimeSource.includes(before), before);
  const source = runtimeSource.replace(before, after)
    .replaceAll('import.meta.url', JSON.stringify(runtimeURL.href))
    .replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from ${JSON.stringify(new URL(path, runtimeURL).href)}`);
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

async function coverRecipe(fn, failures = 3, error = 'COVER_OR_POINTER_UNCONFIRMED') {
  const calls = [], attempts = [];
  let places = 0;
  const operation = fn({ cover: { tag: 'SIT1-cover', lease: { pid: 7 } }, attempts,
    witness: { send: row => calls.push(row.op) },
    guard: { async call(row) { calls.push(row.op); assert.deepEqual(row, { op: 'place-cover', pid: 7, token: 'SIT1-cover' });
      if (++places <= failures) throw Error(error); } },
    check: async () => calls.push('check'), wait: async ms => { assert.equal(ms, 300); calls.push('wait'); },
  });
  if (failures >= 4 || error !== 'COVER_OR_POINTER_UNCONFIRMED') await assert.rejects(operation, new RegExp(error));
  else await operation;
  const expected = Math.min(failures + 1, error === 'COVER_OR_POINTER_UNCONFIRMED' ? 4 : 1);
  assert.equal(places, expected);
  assert.deepEqual(calls, Array.from({ length: expected }, () => ['check', 'order-back', 'wait', 'check', 'place-cover']).flat());
  assert.equal(attempts.length, expected);
  assert.deepEqual(attempts.map(r => r.attempt), Array.from({ length: expected }, (_, i) => i + 1));
}
test('cover retries order-back, 300 ms and placement at most four times', async () => {
  for (const failures of [0, 1, 3, 4]) await coverRecipe(runtime.placeWitnessCover, failures);
  await coverRecipe(runtime.placeWitnessCover, 4, 'FIXTURE_IDENTITY');
});
test('a stop during the cover delay prevents placement', async () => {
  let stopped = false, placed = false;
  await assert.rejects(runtime.placeWitnessCover({ cover: {}, witness: { send() {} },
    guard: { async call() { placed = true; } }, check: async () => { if (stopped) throw Error('PERSON_ACTIVE'); },
    wait: async () => { stopped = true; } }), /PERSON_ACTIVE/);
  assert.equal(placed, false);
});
for (const [name, before, after] of [
  ['no order-back', "witness.send({ op: 'order-back' });", ''],
  ['no delay', 'await wait(300);', ''],
  ['one attempt', 'attempt <= 4', 'attempt <= 1'],
  ['unbounded fifth attempt', 'attempt === 4', 'attempt === 5'],
]) test(`cover regression rejects broken variant: ${name}`, async () => {
  const broken = await variant(before, after);
  await assert.rejects(coverRecipe(broken.placeWitnessCover, 4), /AssertionError|COVER_OR_POINTER_UNCONFIRMED/);
});

async function cleanupRecipe(module, scenario) {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitfix2-lock-test-')));
  const lock = join(bank, 'lock'), displaced = join(bank, 'displaced');
  const toolDir = join(bank, 'tools'); mkdirSync(toolDir);
  mkdirSync(join(toolDir, module.WITNESS.name + '.app/Contents/MacOS'), { recursive: true });
  for (const path of ['guard', module.WITNESS.name + '.app/Contents/MacOS/witness']) writeFileSync(join(toolDir, path), 'not executable');
  let releases = 0, engineCloses = 0, guardCloses = 0, nextRelease;
  try {
    const backend = await module.createOwnerAwayBackend({ tools: toolDir }, {
      platform: 'darwin', env: { CLAUDE_CONFIG_DIR: join(bank, 'config') }, temporaryRoot: bank,
      readObservation: async () => {
        const operations = Array.from({ length: 3 }, (_, i) => module.OBSERVED_KINDS.map(kind => ({ kind, label: `${kind}-${i}` }))).flat();
        const resets = [];
        return { schema: 'sleight.owner-away-sitting/1', observeOnly: true, completed: true, cleanupConfirmed: true,
          finishedAt: new Date().toISOString(), metadata: {}, results: [{ evidence: { operations, resets, ...module.pulseModel(operations, resets) } }] };
      },
      metadata: async () => ({}), printSource() {}, benchmarkDecision() {}, openFixture() {},
      acquireLiveLock: async () => { const release = await acquireLiveLock(lock); return async () => { releases++; await release(); }; },
      startGuard: () => ({ records: [], async readiness() { return { schema: 'sleight.input-readiness/1', ready: true, error: null, drawing: false, qualification: false,
        grants: { quartzListen: 'granted', hidListen: 'granted' }, idleMs: { quartzHID: 10000, quartzSession: 10000, ioHIDSystem: 10000 },
        permissionRequests: 0, tapOpens: 0, deviceOpens: 0, actionCalls: 0 }; }, async start() { if (scenario === 'start') throw Error('GUARD_START_FAILED'); }, async check() {},
        async close() { guardCloses++; if (scenario === 'guard-close') throw Error('GUARD_CLOSE_FAILED'); },
        async quitFixtures() { if (scenario === 'quit') throw Error('CLEANUP_UNCONFIRMED'); return {}; } }),
      probeClient: async () => ({ async close() { engineCloses++; if (scenario === 'engine-close') throw Error('ENGINE_CLOSE_FAILED'); } }),
    });
    const report = await module.runOwnerAway({ backend: { ...backend, async probe() {
      if (scenario === 'stop' || scenario === 'hangup') process.emit(scenario === 'hangup' ? 'SIGHUP' : 'SIGTERM');
      if (scenario === 'replacement') { renameSync(lock, displaced); nextRelease = await acquireLiveLock(lock); }
      throw Error('PROBE_FAILED');
    } } });
    assert.equal(report.completed, false);
    assert.equal(report.cleanup.lockReleased, scenario !== 'replacement');
    assert.equal(existsSync(lock), scenario === 'replacement');
    assert.equal(releases, 1);
    const [first, second] = await Promise.all([backend.close(), backend.close()]);
    assert.equal(first, second);
    assert.equal(guardCloses, 1); assert.equal(engineCloses, scenario === 'start' ? 0 : 1);
    assert.equal(releases, 1);
    if (scenario === 'replacement') {
      assert.equal(report.cleanupConfirmed, false);
      assert.equal(report.cleanup.lockError, 'LIVE_LOCK_RELEASE_FAILED');
      assert.equal(existsSync(displaced), true);
    }
  } finally { await nextRelease?.(); rmSync(bank, { recursive: true, force: true }); }
}
for (const scenario of ['start', 'probe', 'stop', 'hangup', 'quit', 'engine-close', 'guard-close', 'replacement']) {
  test(`runner releases only its own lock: ${scenario}`, () => cleanupRecipe(runtime, scenario));
}
test('lock regression rejects restoring the cleanup-dependent unlock', async () => {
  const broken = await variant('if (unlock) try { await releaseLock();', 'if (cleanup && unlock) try { await releaseLock();');
  await assert.rejects(cleanupRecipe(broken, 'quit'), /AssertionError/);
});
test('a repeatable HID reset does not become permission to ignore a person', async () => {
  const operations = Array.from({ length: 3 }, (_, n) => runtime.OBSERVED_KINDS.map(kind => ({ kind, label: `${kind}-${n}` }))).flat();
  const resets = operations.filter(r => r.kind === 'click').map(r => ({ label: r.label }));
  const evidence = { operations, resets, ...runtime.pulseModel(operations, resets) };
  const report = { schema: 'sleight.owner-away-sitting/1', observeOnly: true, completed: true, cleanupConfirmed: true,
    finishedAt: new Date().toISOString(), metadata: {}, results: [{ evidence }] };
  assert.equal(evidence.stable, true);
  assert.equal(runtime.observationSummary(report).sittingReady, false);
  assert.throws(() => runtime.observationCounts(report, {}), /HID_SOURCE_UNCONFIRMED/);
  const broken = await variant("if (Object.values(model.resetCounts).some(count => count !== 0)) throw Error('HID_SOURCE_UNCONFIRMED');", '');
  assert.equal(broken.observationCounts(report, {}).click, 1);
});

test('cover and runtime HID policy execute offline, and broken predicates fail', { skip: process.platform !== 'darwin', timeout: 900000 }, t => {
  const bank = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-sitfix2-swift-test-')));
  const source = readFileSync(new URL('../bench/sitting-guard.swift', import.meta.url), 'utf8');
  const pure = source.slice(source.indexOf('func runtimeResetAllowance('), source.indexOf('// End pure fixture safety decisions.'));
  const witnessSource = readFileSync(new URL('../bench/runtime-probe-host.swift', import.meta.url), 'utf8');
  const orderBack = /case "order-back": ([^\n]+)/.exec(witnessSource)?.[1];
  assert.ok(orderBack);
  const allowed = /let op = row\["op"\] as\? String, (\[[^\n]+\])\.contains\(op\)/.exec(witnessSource)?.[1];
  assert.ok(allowed?.includes('"order-back"'));
  assert.doesNotMatch(orderBack, /activate|orderFront|makeKey/);
  const program = `import Foundation
import CoreGraphics
${pure}
class FakeWindow { var backs = 0; func orderBack(_ sender: Any?) { backs += 1 } }
class FakeReceiver { let window = FakeWindow() }
let receiver = FakeReceiver()
${orderBack}
let target = CGRect(x: 100, y: 290, width: 640, height: 592), pointer = CGPoint(x: 420, y: 600)
let cover = CoverWindow(pid: 7, frame: target), witness = CoverWindow(pid: 8, frame: target)
let valid = CoverSample(frame: target, visible: [cover, witness])
let stale = CoverSample(frame: CGRect(x: 0, y: 0, width: 656, height: 422), visible: [witness, cover])
var checks = [receiver.window.backs == 1, ${allowed}.contains("order-back")]
func confirmed(_ row: CoverSample, _ p: CGPoint = CGPoint(x: 420, y: 600)) -> Bool {
  coverConfirmed(row, target: target, pointer: p, coverPID: 7, witnessPID: 8)
}
checks += [confirmed(valid), !confirmed(stale), !confirmed(valid, CGPoint(x: 0, y: 0)),
  !confirmed(CoverSample(frame: nil, visible: [cover, witness])),
  !confirmed(CoverSample(frame: target, visible: nil)),
  !confirmed(CoverSample(frame: target, visible: [witness, cover])),
  !confirmed(CoverSample(frame: target, visible: [cover])),
  !confirmed(CoverSample(frame: target, visible: [witness])),
  !confirmed(CoverSample(frame: target, visible: [CoverWindow(pid: 7, frame: CGRect(x: 400, y: 580, width: 50, height: 50)), witness])),
  !confirmed(CoverSample(frame: target, visible: [CoverWindow(pid: 7, frame: CGRect(x: 0, y: 0, width: 900, height: 900)), witness]), CGPoint(x: 10, y: 10)),
  !confirmed(CoverSample(frame: CGRect(x: 400, y: 580, width: 50, height: 50), visible: [cover, witness]))]
for ready in [0.0, 0.15, 0.3, 0.35, Double.infinity] {
  var time = 0.0, samples = 0
  let ok = waitForCover(target: target, pointer: pointer, coverPID: 7, witnessPID: 8,
    sample: { samples += 1; return time + 0.000001 >= ready ? valid : stale }, now: { time }, pause: { time += $0 })
  checks += [ok == (ready <= 0.3), time <= 0.300001, samples <= 7]
}
checks += [runtimeResetAllowance(observeOnly: false, measured: 0) == 0,
  runtimeResetAllowance(observeOnly: false, measured: 1) == nil,
  runtimeResetAllowance(observeOnly: false, measured: nil) == nil,
  runtimeResetAllowance(observeOnly: true, measured: nil) == 32]
print(checks.filter { !$0 }.count)
`;
  const mutations = [
    ['witness never orders back', orderBack, ''],
    ['witness operation refused', allowed, allowed.replace(', "order-back"', '')],
    ['one-shot frame read', 'for _ in 0..<7', 'for _ in 0..<1'],
    ['lost z-order', 'coverAt < witnessAt', 'coverAt != witnessAt'],
    ['lost pointer check', 'frame.contains(pointer)', 'true'],
    ['lost containment', 'frame.contains(target)', 'true'],
    ['stale WindowServer frame', 'serverFrame.contains(target)', 'true'],
    ['extra deadline', 'now() + 0.300', 'now() + 0.400'],
    ['HID count grants authority', 'return measured == 0 ? 0 : nil', 'return measured'],
  ];
  try {
    for (const [name, before, after] of [['production', null, null], ...mutations]) {
      if (before) assert.ok(program.includes(before), name);
      writeFileSync(join(bank, 'pure.swift'), before ? program.replace(before, after) : program);
      const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(bank, 'modules'), join(bank, 'pure.swift'), '-o', join(bank, 'pure')],
        { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(join(bank, 'pure'), [], { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
      assert.equal(run.status, 0, run.stderr);
      if (!before) assert.equal(Number(run.stdout), 0);
      else assert.ok(Number(run.stdout) > 0, `${name} survived`);
      t.diagnostic(`${name}: ${Number(run.stdout)} failed assertions`);
    }
  } finally { rmSync(bank, { recursive: true, force: true }); }
});
