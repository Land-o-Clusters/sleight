import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

// The macOS-only self-test accepts the canonical private temp root, not os.tmpdir().
const hostTemp = process.platform === 'darwin' ? join('/', 'private', 'tmp') : tmpdir();
const folder = realpathSync(trackTemp(mkdtempSync(join(hostTemp, 'sleight-call-host-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  let source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
  const mutations = {
    'ring-skips-call': ['if legacyCallBlocked() { hideLegacyCall(); return }\n        }\n        runtime.book', 'if legacyCallBlocked() { return }\n        }\n        runtime.book'],
    'changed-skips-small': ['else if !self.stageActive { self.observeLegacyCall() }', 'else if !self.stageActive { /* lost completion */ }'],
    'no-call-poll': ['callHidden ? 2 : nil', 'callHidden ? nil : nil'],
    'fast-paused-poll': ['asleep || paused && !timers.contains(where: { $0.action == "park" }) ? 2 : 0.5', 'asleep ? 2 : 0.5'],
    'late-paused-deadline': ['let check = interval.map { now + $0 }, timer = timers.min { $0.at < $1.at }', 'let check = interval.map { now + $0 }, timer: (at: Double, action: String)? = nil'],
    'defer-parked-call': ['if !self.active {\n                if self.legacyCallBlocked()', 'return\n            if !self.active {\n                if self.legacyCallBlocked()'],
    'slow-call-fallback': ['Int((poll ?? 0.5) * 200)', 'Int((interval ?? 0.5) * 200)'],
    'wake-skips-call': ['if self.active && self.legacyCallEvent != nil { self.observeLegacyCall() }', 'if self.active && self.legacyCallEvent != nil { self.perform(self.runtime.observe(self.now, env: self.environment)) }'],
    'small-skips-call': ['return stageCall.active(now)', 'return false'],
    'no-readmit': ['lastSuccessfulInput = false; successfulSampled = completed', 'lastSuccessfulInput = true; successfulSampled = completed'],
    'slot-leaks-lock': ['if descriptor >= 0 { close(descriptor) }; descriptor = -1; display = nil', 'if descriptor >= 0 { /* leaked descriptor */ }; descriptor = -1; display = nil'],
    'call-claims-slot': ['!world.stopped, !world.call,', '!world.locked, !world.sleeping,'],
    'trail-skips-completion': ['self.host?.hideRingCharacter(); self.hideLegacyCall()', '/* lost trail hide */'],
    'queued-draw-skips-call': ['if effects.contains(where: { if case .draw = $0 { return true }; return false }), active() {', 'if false && effects.contains(where: { if case .draw = $0 { return true }; return false }), active() {'],
    'drop-state-filter': ['guard ev.state == "paused" else { return effects }', '/* lost state filter */'],
    'drop-seat-tag': ['if let seat = runtime.seat, seat != previousSeat', 'if let seat = runtime.seat, false'],
    'drop-timer-tag': ['if !due.isEmpty { parts.append', 'if false { parts.append'],
    'drop-startup-tag': ['previousSeat == nil ? "startup" : "seat-hop"', '"seat-hop"'],
    'startup-default': ['var stageBenchInstallCause = "unattributed"', 'var stageBenchInstallCause = "startup"'],
    'drop-cause-tag': ['return parts.joined(separator: "/")', 'return "startup"'],
    'drop-restore-tag': ['stageBenchCause("call-restore",', 'stageBenchCause("call-observe",'],
    'drop-wake-tag': ['stageBenchPreviousCause == "wake" ? "wake" : "call-observe"', '"call-observe"'],
    'repeat-quiet-draw': ['if wasShown && visible && shown,', 'if false && wasShown && visible && shown,'],
    'always-suppress': ['previous.samePose(as: current)', 'true'],
    'ignore-panel-visibility': ['wasShown && visible && shown', 'wasShown && shown'],
    'drop-no-hide': ['!effects.contains(where: { if case .hide = $0.1 { return true }; return false })', 'true'],
    'drop-plan-restore': ['plan = previous; began = previousBegan', '/* lost installed pose */'],
    'drop-only-plan': ['plan = previous; began = previousBegan', 'began = previousBegan'],
    'receive-redraw': ['runtime.receiveVisible(perchEvent(plan), now: at, env: environment, visible: legacyPanelVisible)', 'runtime.receive(perchEvent(plan), now: at, env: environment)'],
    'skip-geometry': ['let effects = observe(now, env: env)', 'let effects: [(Double, PerchEffect)] = []'],
  };
  if (process.env.CHV2XB_BROKEN) {
    const pair = mutations[process.env.CHV2XB_BROKEN];
    assert.ok(pair && source.includes(pair[0]), 'production mutation site');
    // Test-only adapters must never be the mutation target.
    source = source.replace(pair[0], pair[1]);
  }
  if (process.env.CHV4N_BENCH_BROKEN === 'per-install-id') {
    assert.ok(source.includes('if let value = values[plan.stageBenchIdentity] { return value }'));
    source = source.replace('if let value = values[plan.stageBenchIdentity] { return value }', '');
  }
  if (process.env.CHV4N_BENCH_BROKEN === 'merge-equal-plans') {
    assert.ok(source.includes('plan.stageBenchIdentity'));
    source = source.replaceAll('values[plan.stageBenchIdentity]', 'values[UUID(uuidString: "00000000-0000-0000-0000-000000000000")!]');
  }
  const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  const fixtureSetup = fixture.slice(fixture.indexOf('        host.capture = "hidden";'), fixture.indexOf('        stageBenchPlanned ='))
    .replace(/        stageBenchLegacyWindowFrame = \{[\s\S]*?^        \}\n/m, '');
  const fixturePark = fixture.slice(fixture.indexOf('                activity = "parked"'), fixture.indexOf('            case "hide": host.hide();'));
  source = source.replace('} else if row["settle"] as? Bool == true,', `} else if row["benchPark"] as? Bool == true {
            let host = owner
            ${fixtureSetup}
            var activity = "animate"
            ${fixturePark}
            precondition(activity == "parked")
        } else if row["unloadStage"] as? Bool == true {
            perch.stage.load(nil)
        } else if row["dueWake"] as? Bool == true {
            perch.legacyCallEvent = nil
            perch.runtime.timer(perch.now, "sleep"); perch.schedule()
            RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.03))
        } else if row["settle"] as? Bool == true,`);
  source = source.replace('    var sequence = 0\n    while let line = readLine()', `    owner.ringEnvironmentProvider = { RingEnvironment(bounds: { _, _ in bounds }, reduced: { true }, secure: { false }) }
    owner.ringEffects = { effects in
        for (_, effect) in effects { if case let .draw(plan, _) = effect { perch.ringDrew(plan) } }
    }
    var sequence = 0
    while let line = readLine()`);
  source = source.replace('            perch.ringDrew(plan)\n        } else if row["benchPark"]', `            owner.pauseTarget = RingEvent(seq: sequence, state: plan.state, pid: 42, windowId: 7, at: plan.at, rect: nil, label: nil)
            perch.ringDrew(plan)
        } else if row["benchPark"]`);
  const counters = fixture.slice(fixture.indexOf('struct StageBenchInstalls {'), fixture.indexOf('func stageBenchModel()'));
  source += `
${counters}
var stageBenchInstalled: ((PerchHost, PerchPlan, PerchMetrics, SpriteStagePose?, Double) -> Void)?
var stageBenchPlanned: ((Int, PerchPlan, PerchMetrics) -> Void)?
var stageBenchPointerPosition: CGPoint?, stageBenchPersonWindow: StageWindowKey?
var stageBenchPointerObserved: (([StageEffect], Int?, CGRect?, Double) -> Void)?
func stageBenchMain(_ args: [String]) { exit(64) }
`;
  source = source.replace('let perch = owner.perch\n    owner.cursorStyle', `let perch = owner.perch
    var nativeBenchInstalls = StageBenchInstalls(), nativeBenchSeq = 0
    stageBenchPlanned = { seq, plan, metrics in
        nativeBenchSeq = seq; nativeBenchInstalls.expect(stageBenchPlanID(seq, plan, metrics))
    }
    stageBenchInstalled = { host, plan, metrics, _, ms in
        nativeBenchInstalls.record(stageBenchPlanID(nativeBenchSeq, plan, metrics), hostTimeMs: CACurrentMediaTime() * 1000, installMs: ms, cause: host.stageBenchInstallCause)
    }
    owner.cursorStyle`);
  source = source.replace('"windows": owner.panel == nil', '"installCauses": nativeBenchInstalls.causes, "installsPerPlan": nativeBenchInstalls.perPlan, "doubleInstalls": nativeBenchInstalls.doubleInstalls, "windows": owner.panel == nil');
  const input = join(folder, 'host.swift'); binary = join(folder, 'host'); writeFileSync(input, source);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_CALL_SELFTEST', '-D', 'SLEIGHT_STAGE_BENCH', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  return binary;
}
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = (size = 'small') => ({ character: { hand: 'character', nonce: 'a'.repeat(64), seq: 1, id: 'fixture',
  sheet: join(folder, 'sheet.png'), extra: null, cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size, stageAttention: false } });
function dump(lines) {
  const result = spawnSync(host(), ['--call-host-selftest', join(folder, 'single-slots')], {
    input: lines.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  for (const row of rows) { assert.equal(row.windows, 0); assert.equal(row.layers, 0); }
  return rows;
}
const native = { skip: process.platform !== 'darwin' && 'Swift host fixture needs macOS' };
test('an unloaded host stays on the legacy path while an unspecified loaded character chooses medium', native, () => {
  const medium = character(); delete medium.character.size;
  const rows = dump([{ stats: true }, medium, { unloadStage: true }]);
  assert.deepEqual(rows.map(row => row.size), ['small', 'medium', 'small']);
  assert.ok(rows.every(row => row.visible === false));
});
test('CHV6 fixture park reaches the small runtime before its sleep deadline', native, () => {
  const rows = dump([{ clock: 100 }, character(), { ring: true }, { benchPark: true }, { settle: true }, { dueTimer: 'sleep' }]);
  assert.equal(rows[3].pose, 'paused');
  assert.ok(!rows[3].timers.includes('sleep'));
  assert.equal(rows[5].installs, rows[4].installs, 'a parked small character installs nothing on sleep');
  assert.equal(rows[5].visible, true);
});
test('CHV6 scheduled sleep wake retains an unchanged installed plan and clock', native, () => {
  const rows = dump([{ clock: 100 }, character(), { ring: true }, { dueTimer: 'sleep' }, { settle: true }, { dueWake: true }]);
  assert.equal(rows[5].installs, rows[4].installs);
  assert.equal(rows[5].began, rows[4].began);
  assert.deepEqual(rows[5].posePlan, rows[4].posePlan);
});
test('CHV6 scheduled sleep wake installs a changed plan exactly once', native, () => {
  const rows = dump([{ clock: 100 }, character(), { ring: true }, { settle: true }, { dueWake: true }]);
  assert.equal(rows[4].installs, rows[3].installs + 1);
  assert.equal(rows[4].pose, 'sleep');
});
test('CHV4Q paused host slows only after park and keeps exact animation and line deadlines', native, () => {
  const rows = dump([{ clock: 100 }, { ...character(), reduced: false }, { ring: true, state: 'paused' },
    { settle: true }, { timer: { after: 0.123, action: 'line-out' } }, { ring: true, state: 'click' }]);
  assert.equal(rows[2].poll, 0.5, 'arrival and paused reaction keep their animation deadline');
  assert.equal(rows[2].nextWake.source, 'legacy-window-check');
  assert.equal(rows[3].poll, 2); assert.equal(rows[3].nextWake.at, rows[3].time + 2);
  assert.equal(rows[3].nextWake.source, 'legacy-window-check'); assert.equal(rows[3].nextWake.leewayMs, 400);
  assert.equal(rows[4].nextWake.at, rows[4].time + 0.123);
  assert.equal(rows[4].nextWake.source, 'legacy-timer:line-out'); assert.equal(rows[4].nextWake.leewayMs, 10);
  assert.equal(rows[5].poll, 0.5, 'an action resumes the awake cadence immediately');
});
for (const size of ['small', 'medium', 'stage']) {
  test('CHV4Q confirmed call starting while parked hides ' + size + ' before any fallback clock step', native, () => {
    const rows = dump([{ clock: 100 }, character(size), { ring: true, state: 'paused' },
      ...size === 'small' ? [{ settle: true }] : [],
      { sample: 'input-active' }, { sample: 'timeout' }, { sample: 'unavailable' }, { sample: 'quiet' }]);
    const shown = rows[rows.length - 5], [live, timeout, unavailable, quiet] = rows.slice(-4);
    assert.equal(shown.visible, true); assert.equal(live.time, shown.time);
    for (const hidden of [live, timeout, unavailable]) {
      assert.equal(hidden.visible, false); assert.equal(hidden.reason, 'call'); assert.equal(hidden.slot, null);
    }
    assert.equal(quiet.visible, true, 'only the next successful quiet reading restores the character');
  });
}
for (const state of ['click', 'double', 'right', 'type', 'key', 'scroll', 'done']) {
  test('CHV4O identical ' + state + ' frames both install after the previous reaction parks', native, () => {
    const rows = dump([{ ...character(), reduced: false }, { ring: true }, { ring: true }, { ring: true, state, ok: true },
      { settle: true }, { ring: true, state, ok: true }, { settle: true }, { ring: true, state, ok: true }]);
    assert.equal(rows[5].installs, rows[3].installs + 1);
    assert.equal(rows[7].installs, rows[5].installs + 1);
    assert.deepEqual(rows[5].posePlan, rows[7].posePlan, 'the replayed plans really are identical');
    assert.ok(rows[5].posePlan.duration > 0, 'normal-motion reaction has a positive duration');
    assert.equal(rows[5].posePlan.reduced, false);
  });
}
test('CHV4O identical paused frame remains suppressed after normal motion parks', native, () => {
  const rows = dump([{ ...character(), reduced: false }, { ring: true, state: 'paused' }, { settle: true },
    { ring: true, state: 'paused' }, { settle: true }, { sample: 'quiet' }, { ring: true, state: 'paused' }]);
  assert.equal(rows[4].installs, rows[3].installs, 'parking installs nothing');
  assert.equal(rows[6].installs, rows[3].installs, 'the paused replay keeps its parked pose');
  assert.equal(rows[6].began, rows[3].began); assert.deepEqual(rows[6].posePlan, rows[3].posePlan);
});
test('CHV4O native installs identify receive, due timer, call restore and unattributed installs', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { dueTimer: 'sleep' },
    { sample: 'input-active' }, { sample: 'quiet' }, { installAgain: true }]);
  const causes = rows.at(-1).installCauses;
  assert.equal(causes[0].cause, 'ring-receive/startup');
  assert.equal(causes[1].cause, 'ring-receive');
  assert.match(causes[2].cause, /^call-observe\/due-timer:.*sleep/);
  assert.match(causes[3].cause, /^call-restore\/startup$/);
  assert.equal(causes[4].cause, 'unattributed', 'a direct install must differ from an attributed startup');
  assert.equal(causes.length, rows.at(-1).installs);
  assert.equal(rows[4].installs, rows[3].installs, 'call hide installs nothing');
  for (const cause of causes) { assert.equal(typeof cause.id, 'string'); assert.ok(cause.hostTimeMs > 0); }
});
test('CHV4C real legacy completion suppresses an identical pose but still applies changed visibility', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { samePoseTimer: true }, { sample: 'input-active' }, { sample: 'quiet' }]);
  assert.equal(rows[2].installs, 2);
  assert.equal(rows[3].installs, 2, 'quiet observer cannot reinstall the same pose at the same seat');
  assert.equal(rows[4].visible, false); assert.equal(rows[5].visible, true);
  assert.equal(rows[5].installs, 3, 'quiet after confirmed live must re-admit');
});
test('CHV4N due sleep installs a changed pose during a quiet observation', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { dueTimer: 'sleep' }]);
  assert.equal(rows[2].pose, 'perch');
  assert.equal(rows[3].pose, 'sleep'); assert.equal(rows[3].installs, rows[2].installs + 1);
});
test('CHV4N identical observer draw restores its installed plan clock', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { samePoseTimer: true }, { installAgain: true }]);
  assert.equal(rows[3].installs, rows[2].installs); assert.equal(rows[3].began, rows[2].began);
  assert.deepEqual(rows[4].installsPerPlan, [1, 2], 'the retained runtime plan is the installed plan, including its identity');
});
test('CHV4N an ordered-out panel still draws the identical observed plan', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { panelVisible: false }, { samePoseTimer: true }]);
  assert.equal(rows[3].shown, true); assert.equal(rows[3].visible, false);
  assert.equal(rows[4].installs, rows[3].installs + 1); assert.equal(rows[4].visible, true);
});
test('CHV4N moved and covered seats retain their hide effects during quiet observation', native, () => {
  for (const reason of ['moved', 'covered']) {
    const rows = dump([character(), { ring: true }, { ring: true }, { geometry: reason }]);
    assert.equal(rows.at(-1).visible, false); assert.equal(rows.at(-1).reason, reason);
  }
});
test('CHV4N paused receive suppresses a repeated pose and preserves its clock after a quiet completion', native, () => {
  const rows = dump([character(), { ring: true, state: 'paused' }, { ring: true, state: 'paused' },
    { sample: 'quiet' }, { ring: true, state: 'paused' }]);
  assert.equal(rows[3].installs, rows[2].installs, 'quiet completion alone has no due paused draw');
  assert.equal(rows[4].installs, rows[2].installs); assert.equal(rows[4].began, rows[2].began);
  assert.equal(rows[4].pose, 'paused'); assert.equal(rows[4].visible, true);
  assert.ok(!rows[4].timers.some(t => ['sleep', 'wait-end', 'drop'].includes(t)));
});
test('CHV4O moved-seat return identifies the wake timer and seat hop', native, () => {
  const rows = dump([character(), { ring: true }, { ring: true }, { geometry: 'moved' }, { wait: 0.7 }]);
  assert.equal(rows[3].visible, false); assert.equal(rows[4].visible, true);
  assert.match(rows[4].installCauses.at(-1).cause, /^wake\/due-timer:.*return.*\/seat-hop$/);
});
test('CHV4N receive never suppresses the draw after a due hide even when the pose matches', native, () => {
  const rows = dump([character(), { ring: true, state: 'paused' }, { receiveAfterDeep: true }]);
  assert.equal(rows[2].installs, rows[1].installs + 1); assert.equal(rows[2].visible, true);
});
test('CHV4N real host double install shares an identity while two new equal plans stay distinct', native, () => {
  const rows = dump([character(), { ring: true, state: 'paused' }, { freshPlan: true }, { installAgain: true }, { freshPlan: true }]);
  assert.deepEqual(rows[3].installsPerPlan, [1, 2]);
  assert.deepEqual(rows[4].installsPerPlan, [1, 2, 1]);
  assert.equal(rows[4].doubleInstalls.length, 1);
  assert.deepEqual(rows[2].posePlan, rows[4].posePlan, 'distinct plan identities have identical visual data');
  const records = rows[4].doubleInstalls[0].installs;
  assert.equal(records.length, 2); assert.ok(records[1].hostTimeMs > records[0].hostTimeMs);
  assert.equal(rows[4].installs, 4);
});
test('real small ringDrew hides an existing renderer on live input and quiet restores it', native, () => {
  const rows = dump([character(), { sample: 'quiet' }, { ring: true }, { callbacks: false },
    { sample: 'input-active' }, { ring: true }, { sample: 'quiet' }, { ring: true }]);
  assert.equal(rows[2].visible, true);
  assert.equal(rows[5].visible, false, 'ringDrew must remove the existing renderer');
  assert.equal(rows[5].reason, 'call'); assert.equal(rows[7].visible, true);
});
test('real changed closure hides small on live, retains failures, and restores quiet', native, () => {
  const rows = dump([character(), { ring: true }, { sample: 'input-active' }, { sample: 'timeout' },
    { sample: 'unavailable' }, { sample: 'quiet' }]);
  assert.equal(rows[1].visible, true);
  for (const row of rows.slice(2, 5)) { assert.equal(row.visible, false, 'completion hides small'); assert.equal(row.reason, 'call'); }
  assert.equal(rows[5].visible, true, 'quiet completion re-admits small');
});
test('real two-second call poll and wake dispatcher re-admit small without a completion callback', native, () => {
  const rows = dump([character(), { ring: true }, { sample: 'input-active' }, { callbacks: false },
    { sample: 'quiet' }, { stats: true }, { wait: 1 }, { wait: 1.35 }]);
  assert.equal(rows[2].poll, null, 'call hide removes legacy seat');
  assert.equal(rows[2].wake, true, 'call-hidden renderer needs its fallback poll');
  assert.equal(rows[2].nextWake.leewayMs, 100, 'call-hidden fallback keeps its existing leeway');
  assert.equal(rows[6].visible, false, 'two-second poll must not fire at one second');
  assert.equal(rows[7].visible, true, 'wake dispatcher must re-admit retained event');
  assert.match(rows[7].installCauses.at(-1).cause, /^call-restore/);
});
test('real wake dispatcher retains live hide instead of directly observing the legacy runtime', native, () => {
  const rows = dump([character(), { ring: true }, { sample: 'input-active' }, { wait: 2.35 }]);
  assert.equal(rows.at(-1).visible, false); assert.equal(rows.at(-1).reason, 'call');
  assert.equal(rows.at(-1).wake, true, 'call poll continues while hidden');
});
test('real stage apply veto rejects a queued quiet draw delivered after live input', native, () => {
  const rows = dump([character('stage'), { ring: true }, { queuedDraw: true }]);
  assert.equal(rows[1].visible, true); assert.equal(rows[1].rung, 'stage');
  assert.equal(rows[2].visible, false, 'queued draw must consult the shared apply hook');
  assert.equal(rows[2].slot, null, 'call-hidden host cannot hold a slot');
});

async function interactive(slotRoot) {
  const child = spawn(host(), ['--call-host-selftest', slotRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', pending, closed = false;
  const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { buffer += data; pending?.(); });
  child.stdin.on('error', () => {});
  return {
    async send(row) {
      child.stdin.write(JSON.stringify(row) + '\n');
      let timer;
      try {
        return await Promise.race([new Promise(resolve => {
          pending = () => {
            const end = buffer.indexOf('\n'); if (end < 0) return;
            const row = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); pending = null;
            assert.equal(row.windows, 0); assert.equal(row.layers, 0); resolve(row);
          }; pending();
        }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('host reply timeout: ' + stderr)), 5000); })]);
      } finally { clearTimeout(timer); }
    },
    async close() {
      child.stdin.end(); let timer;
      try {
        const result = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('host EOF timeout')), 3000); })]);
        assert.equal(result.code, 0, stderr);
      } finally { clearTimeout(timer); if (!closed) { child.kill('SIGKILL'); await exit; } }
    },
  };
}
test('two real hosts share one display slot, release on call, and recover stage after contention', native, async () => {
  const slotRoot = join(folder, 'shared-slots');
  const a = await interactive(slotRoot), b = await interactive(slotRoot);
  try {
    await a.send(character('stage')); await b.send(character('stage'));
    const first = await a.send({ ring: true }), second = await b.send({ ring: true });
    assert.equal(first.rung, 'stage'); assert.equal(first.slot, '1');
    assert.equal(second.slot, null); assert.ok(['medium', 'small'].includes(second.rung), 'contending host must use a smaller rung');
    const hidden = await a.send({ sample: 'input-active' });
    assert.equal(hidden.visible, false); assert.equal(hidden.slot, null, 'call hide must release slot');
    const winner = await b.send({ observe: true });
    assert.equal(winner.rung, 'stage', 'other host must acquire the released flock'); assert.equal(winner.slot, '1');
    const quiet = await a.send({ sample: 'quiet' });
    assert.equal(quiet.slot, null); assert.ok(['medium', 'small'].includes(quiet.rung));
    const otherHidden = await b.send({ sample: 'input-active' });
    assert.equal(otherHidden.slot, null); assert.equal(otherHidden.visible, false);
    const recovered = await a.send({ observe: true });
    assert.equal(recovered.rung, 'stage', 'original host must recover its configured stage size');
    assert.equal(recovered.size, 'stage'); assert.equal(recovered.slot, '1');
  } finally { await a.close(); await b.close(); }
});

test('call-hidden admission refuses the slot before any claim', native, () => {
  const rows = dump([character('stage'), { admissionCall: true }]);
  assert.equal(rows.at(-1).slot, null);
});

test('ring-trail character speech hides on a confirmed call completion without a draw', native, () => {
  const rows = dump([character(), { trail: true }, { sample: 'input-active' }, { sample: 'timeout' }]);
  assert.equal(rows[1].visible, true);
  assert.equal(rows[2].visible, false); assert.equal(rows[2].reason, 'call');
  assert.equal(rows[3].visible, false);
});
