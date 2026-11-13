import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { recordPacingMotion, rendererDump } from '../bench/hand/stage-live.mjs';
let measurement = await import('../bench/hand/stage-measurement.mjs');

const variant = process.env.CHV4A_BROKEN;
let pacingMotion = recordPacingMotion, renderDump = rendererDump;
const fixtureURL = new URL('../bench/hand/stage-fixture.swift', import.meta.url);
const productURL = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
if (['ignore-schedule-refusal', 'drop-double-evidence', 'drop-install-causes'].includes(variant)) {
  const url = new URL('../bench/hand/stage-live.mjs', import.meta.url);
  const source = mutate(readFileSync(url, 'utf8'), {
    'drop-install-causes': ['installCauses: snapshot.installCauses, ', ''],
    'ignore-schedule-refusal': ['if (started.ok === false)', 'if (false)'],
    'drop-double-evidence': ['doubleInstalls: snapshot.doubleInstalls, ', ''],
  }).replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => 'from ' + q + new URL(path, url).href + q)
    .replaceAll('import.meta.url', JSON.stringify(url.href));
  const live = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  pacingMotion = live.recordPacingMotion; renderDump = live.rendererDump;
}
if (['merge-reaped-cpu', 'ignore-worker-lifetime', 'skip-decode-settle'].includes(variant)) {
  const url = new URL('../bench/hand/stage-measurement.mjs', import.meta.url);
  const source = mutate(readFileSync(url, 'utf8'), {
    'merge-reaped-cpu': ['delta(a.microphoneWorker.cpuS, b.microphoneWorker.cpuS)', 'delta(a.childrenCpuS, b.childrenCpuS)'],
    'ignore-worker-lifetime': ['a.microphoneWorker.startID === b?.microphoneWorker?.startID', 'true'],
    'skip-decode-settle': ['if (session.ready?.parkedReady === true)', 'if (false)'],
  }).replace(/from (['"])(\.[^'"]+)\1/g, (_, q, path) => 'from ' + q + new URL(path, url).href + q);
  measurement = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}
function mutate(source, changes) {
  if (!changes[variant]) return source;
  const [before, after] = changes[variant]; assert.ok(source.includes(before), 'mutation site ' + variant);
  return source.replace(before, after);
}
function slice(source, a, b) {
  const start = source.indexOf(a), end = source.indexOf(b, start);
  assert.ok(start >= 0 && end > start, 'source seam ' + a); return source.slice(start, end);
}
function swift(t, source) {
  const root = registerTemp(t, mkdtempSync(join(tmpdir(), 'chv4a-'))), main = join(root, 'main.swift'), binary = join(root, 'check');
  writeFileSync(main, 'import Foundation\nimport QuartzCore\nimport CryptoKit\n' + source);
  const build = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), main, '-o', binary],
    { encoding: 'utf8', timeout: 120000, killSignal: 'SIGKILL' });
  assertChildStatus(build, 0, build.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr); return JSON.parse(run.stdout);
}

test('CHV4A scheduling diagnostics retain each subtype and post-failure state', { skip: process.platform !== 'darwin' }, t => {
  const fixture = mutate(readFileSync(fixtureURL, 'utf8'), {
    'drop-subtype': ['String(describing: error)', '"unknown"'],
    'drop-motion-timers': ['"motionTimers": timers', '"motionTimers": [:] as [String: Double]'],
    'drop-animation-keys': ['"motionTimers": timers, "animationKeys": layer?.animationKeys() ?? []', '"motionTimers": timers, "animationKeys": [] as [String]'],
  });
  const helpers = slice(fixture, 'func stageBenchLayerState(', '@discardableResult') +
    slice(fixture, 'enum StageBenchScheduleError:', 'final class StageBench {');
  const rows = swift(t, helpers + '\nprint(String(data: try! JSONSerialization.data(withJSONObject: stageBenchScheduleFailures()), encoding: .utf8)!)');
  assert.deepEqual(rows.map(r => r.reason), ['productionTimers', 'missingPosition', 'missedStart']);
  assert.equal(rows[0].motionTimers.phase, 2); assert.deepEqual(rows[0].animationKeys, ['position']);
  for (const row of rows) { assert.equal(row.ok, false); assert.equal(row.error, 'scheduled-motion-install'); }
});

test('CHV4B cancels wakes rearmed after prepare immediately before preinstallation', { skip: process.platform !== 'darwin' }, t => {
  const fixture = mutate(readFileSync(fixtureURL, 'utf8'), {
    'late-quiesce': ['stageBenchQuiesce(host)\n                do { self.motionTiming = try stageBenchScheduledInstall(start, timers: { self.motionTimers }, install: {', 'do { self.motionTiming = try stageBenchScheduledInstall(start, timers: { self.motionTimers }, install: {\n                    stageBenchQuiesce(host)'],
    'keep-perch-wake': ['host.perch.wake?.cancel(); host.perch.wake = nil', ''],
    'keep-ring-wake': ['host.ringWake?.cancel(); host.ringWake = nil', ''],
    'keep-badge-wake': ['host.pauseOverlay.pending?.cancel(); host.pauseOverlay.pending = nil', ''],
  });
  const helpers = slice(fixture, 'func stageBenchLayerState(', '@discardableResult') +
    slice(fixture, 'func stageBenchQuiesce(', 'enum StageBenchScheduleError:') +
    slice(fixture, 'enum StageBenchScheduleError:', 'final class StageBench {');
  assert.match(slice(fixture, 'case "start":', 'default: exit(65)'), /stageBenchQuiesce\(host\)[\s\S]*stageBenchScheduledInstall\(/);
  const row = swift(t, `
final class Wake { var cancelled = false; func cancel() { cancelled = true } }
final class Perch { var wake: Wake? = Wake() }
final class Badge { var pending: Wake? = Wake() }
final class HandHost { let perch = Perch(), pauseOverlay = Badge(); var ringWake: Wake? = Wake() }
${helpers}
let host = HandHost(), wakes = [host.perch.wake!, host.ringWake!, host.pauseOverlay.pending!]
let layer = CALayer(), track = CABasicAnimation(keyPath: "position"); track.beginTime = 1; layer.add(track, forKey: "position")
func timers() -> [String: Double] { ["perchWake": host.perch.wake == nil ? 0 : 1, "ringWake": host.ringWake == nil ? 0 : 1] }
var refused = false
do { _ = try stageBenchScheduledInstall(1500, clock: { 1000 }, timers: timers, install: { layer }, control: { _, _ in [:] }) }
catch { refused = String(describing: error) == "productionTimers" }
stageBenchQuiesce(host)
let result = try stageBenchScheduledInstall(1500, clock: { 1000 }, timers: timers, install: { layer }, control: { _, _ in [:] })
print(String(data: try JSONSerialization.data(withJSONObject: ["refusedBefore": refused, "cancelled": wakes.map { $0.cancelled },
    "badgePending": host.pauseOverlay.pending != nil, "timing": result]), encoding: .utf8)!)
`);
  assert.equal(row.refusedBefore, true); assert.deepEqual(row.cancelled, [true, true, true]); assert.equal(row.badgePending, false);
  assert.equal(row.timing.scheduleMode, 'preinstalled'); assert.equal(row.timing.productionTimersUnchanged, true);
});

test('CHV4A live boundary preserves scheduling diagnostics and can query the failed fixture', async () => {
  const failure = { ok: false, reply: 'start', error: 'scheduled-motion-install', reason: 'productionTimers',
    source: 'character', motionTimers: { perchWake: 1 }, animationKeys: ['position'] };
  const status = { shown: true, panelID: 77, panelGenerations: 1, hideReasonCounts: {}, hostTimeMs: 1000 };
  const commands = [], session = { rows: [], request: async value => {
    commands.push(value.bench);
    if (value.bench === 'start') { session.rows.push(failure); return failure; } return status;
  } };
  const recorder = { rows: [{ ready: true }], wait: async () => ({ ready: true }), write() {}, close: async () => ({ code: 0 }) };
  await assert.rejects(pacingMotion(session, recorder, status), error => {
    assert.match(error.message, /productionTimers/); assert.deepEqual(error.pacingEvidence.sessionRows, [failure]);
    assert.deepEqual(error.pacingEvidence.failureQuery, status); return true;
  });
  assert.deepEqual(commands, ['query', 'start', 'query']);
});

test('CHV4D legacy identities separate identical poses and retain real double-install timestamps', { skip: process.platform !== 'darwin' }, t => {
  const product = mutate(readFileSync(productURL, 'utf8'), {
    'reuse-legacy-id': ['if let value = values[plan.stageBenchIdentity] { return value }', 'return -1'],
  });
  assert.match(product, /#if SLEIGHT_STAGE_BENCH\s+var stageBenchLegacyPlans = StageBenchPlanSequence\(\)/);
  assert.match(product, /stageBenchPlanned\?\(stageBenchLegacyPlans.next\(plan\), plan, metrics\)/);
  const fixture = mutate(readFileSync(fixtureURL, 'utf8'), {
    'hide-double-install': ['counts[id] = count + 1', 'counts[id] = 1'],
  });
  const row = swift(t, slice(product, 'struct StageBenchPlanSequence {', '#endif') +
    slice(fixture, 'struct StageBenchInstalls {', 'func stageBenchModel()') + `
struct PerchMetrics { let size = CGSize(width: 96, height: 104), scale = 0.5 }
struct PerchPlan { let stageBenchIdentity = UUID(); func json(_ size: CGSize) -> [String: Any] { ["pose": "same"] } }
var sequence = StageBenchPlanSequence(), installs = StageBenchInstalls()
let planA = PerchPlan(), planB = PerchPlan()
let a = stageBenchPlanID(sequence.next(planA), planA, PerchMetrics())
let b = stageBenchPlanID(sequence.next(planB), planB, PerchMetrics())
for id in [a, b] { installs.expect(id); installs.record(id, hostTimeMs: 1000, installMs: 0.5) }
let singles = installs.perPlan
installs.record(b, hostTimeMs: 1001, installMs: 0.6)
print(String(data: try! JSONSerialization.data(withJSONObject: ["singles": singles, "doubles": installs.doubleInstalls]), encoding: .utf8)!)
`);
  assert.deepEqual(row.singles, [1, 1]); assert.equal(row.doubles.length, 1);
  assert.deepEqual(row.doubles[0].installs.map(r => r.hostTimeMs), [1000, 1001]);
  assert.deepEqual(renderDump({ doubleInstalls: row.doubles }).doubleInstalls, row.doubles);
});

test('CHV4O every install carries its caller through snapshot and renderer evidence', { skip: process.platform !== 'darwin' }, t => {
  const fixture = mutate(readFileSync(fixtureURL, 'utf8'), {
    'drop-snapshot-causes': ['"installCauses": installs.causes,', ''],
    'drop-unplanned-cause': ['causes.append(row)', 'if counts[id] != nil { causes.append(row) }'],
    'drop-record-cause': ['"cause": cause', '"cause": "unknown"'],
    'drop-host-cause': ['cause: perch.stageBenchInstallCause', 'cause: "startup"'],
    'startup-counter-default': ['cause: String = "unattributed"', 'cause: String = "startup"'],
  });
  assert.match(slice(fixture, 'func snapshot() -> [String: Any] {', 'func command(_ row:'), /"installCauses": installs\.causes/);
  assert.match(fixture, /self\.installs\.record\([^\n]+cause: perch\.stageBenchInstallCause\)/);
  const row = swift(t, slice(fixture, 'struct StageBenchInstalls {', 'func stageBenchPlanID(') + `
var installs = StageBenchInstalls()
installs.expect("same-plan")
installs.record("same-plan", hostTimeMs: 1000, installMs: 0.2, cause: "ring-receive")
installs.record("same-plan", hostTimeMs: 2000, installMs: 0.3, cause: "call-restore")
installs.record("orphan", hostTimeMs: 3000, installMs: 0.4, cause: "wake")
installs.record("direct", hostTimeMs: 4000, installMs: 0.5)
print(String(data: try! JSONSerialization.data(withJSONObject: ["installCauses": installs.causes,
    "doubles": installs.doubleInstalls]), encoding: .utf8)!)
`);
  assert.deepEqual(row.installCauses.map(r => r.cause), ['ring-receive', 'call-restore', 'wake', 'unattributed']);
  assert.deepEqual(row.installCauses.map(r => r.hostTimeMs), [1000, 2000, 3000, 4000]);
  assert.deepEqual(row.doubles[0].installs, row.installCauses.slice(0, 2));
  assert.deepEqual(renderDump(row).installCauses, row.installCauses);
});

test('CHV4F parked child figures separate the persistent microphone worker from collected decode CPU', () => {
  const endpoint = (cpuS, reaped, id = 'worker:1') => ({ processTree: { childrenCpuS: cpuS + reaped,
    reapedChildrenCpuS: reaped, liveChildren: 1, microphoneWorker: { startID: id, cpuS } } });
  const a = endpoint(1, 0.3), b = endpoint(1.004, 0.42);
  assert.equal(typeof measurement.stageParkedChildFigures, 'function');
  const result = measurement.stageParkedChildFigures(a, b);
  assert.ok(Math.abs(result.microphoneWorkerCpuS - 0.004) < 1e-9);
  assert.ok(Math.abs(result.reapedChildrenCpuS - 0.12) < 1e-9);
  assert.equal(result.workerLifetimeStable, true);
  assert.equal(measurement.stageParkedChildFigures(a, endpoint(1.1, 0.42, 'replacement')).microphoneWorkerCpuS, null);
  assert.equal(measurement.stageParkedChildFigures(a, endpoint(1.1, 0.42, 'replacement')).workerLifetimeStable, false);
  assert.equal(measurement.stageParkedChildFigures(a, endpoint(0.9, 0.42)).microphoneWorkerCpuS, null);
});

test('CHV4F parked baseline follows settled decode and keeps decode CPU outside the worker interval', async () => {
  let clock = 0, samples = [], calls = 0, readyCalls = 0;
  const status = () => ({ pid: 42, panelID: 77, installCount: 1, hideReasonCounts: {},
    processTree: { startID: 'host', nonWorkerChildren: 0, liveChildren: 1,
      childrenCpuS: calls === 1 ? 1.12 : 1.124, reapedChildrenCpuS: 0.12,
      microphoneWorker: { startID: 'worker', cpuS: calls === 1 ? 1 : 1.004 } } });
  const session = { ready: { parkedReady: true }, request: async ({ bench }) => {
    assert.equal(bench, 'parkReady'); return { ready: ++readyCalls > 1 };
  }, sampler: { samples, pause: async () => {}, stop: async () => {}, sample: async () => {
    calls++; samples.push({ t: clock, status: status() });
  } } };
  const result = await measurement.collectParkedInterval({ session, size: 'small', wait: async ms => { clock += ms; }, recordVisibility() {} });
  assert.equal(result.parkedStart, 6250); assert.equal(result.idleEnd, 67250); assert.equal(calls, 2); assert.equal(readyCalls, 2);
  assert.ok(Math.abs(result.parkedChildren.microphoneWorkerCpuS - 0.004) < 1e-9);
  assert.equal(result.parkedChildren.reapedChildrenCpuS, 0);
});
