import { assertChildStatus } from './fixtures/child-status.mjs';
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { STAGE_BROKEN_VARIANTS, breakStage } from './fixtures/stage-broken-variants.mjs';
import { runStageFuzz, runStageObligationFuzz, auditStageTrace } from './fixtures/stage-stateful-fuzz.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertStagePointerStrings } from './fixtures/stage-bench-strings.mjs';
import { collectStageTrace, stageTraceLines } from './fixtures/stage-trace-chunks.mjs';

// Geometry and plans only. This mode creates no application, window, layer or image decoder.
const source = process.env.CHRET4_BASELINE_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname;
const folder = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-stage-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  const output = join(folder, 'host');
  let compileSource = source;
  if (process.env.CHRET2_BROKEN_VARIANT || process.env.CHRET4_POINTER_VARIANT) {
    compileSource = join(folder, 'broken.swift');
    const text = readFileSync(source, 'utf8');
    const changed = process.env.CHRET4_POINTER_VARIANT === 'no-pointer-exit-margin' ? text.replace('stagePointRect(world.pointer, 56)', 'stagePointRect(world.pointer, 40)') :
      process.env.CHRET4_POINTER_VARIANT ? text.replace('if pointerBlocked && !badgeApproach', 'if false && pointerBlocked && !badgeApproach') : breakStage(text, process.env.CHRET2_BROKEN_VARIANT);
    assert.notEqual(changed, text, 'production pointer mutation site'); writeFileSync(compileSource, changed);
  }
  if (process.env.CHV2X_STAGE_BROKEN) {
    compileSource = join(folder, 'broken-call.swift');
    const text = readFileSync(source, 'utf8');
    const changes = {
      'pending-hides': ['lastSuccessfulInput == true\n    }', 'pending || lastSuccessfulInput == true\n    }'],
      'timeout-hides': ['// A failure neither clears', 'if result.state == "timeout" { lastSuccessfulInput = true }\n        // A failure neither clears'],
      'expiry-hides': ['lastSuccessfulInput == true\n    }', 'lastSuccessfulInput == true || successfulSampled.isFinite && now - successfulSampled > 1\n    }'],
    };
    const [before, after] = changes[process.env.CHV2X_STAGE_BROKEN];
    assert.ok(text.includes(before)); writeFileSync(compileSource, text.replaceAll(before, after));
  }
  if (process.env.CHV4C_BROKEN) {
    compileSource = join(folder, 'broken-recheck.swift');
    const text = readFileSync(source, 'utf8');
    const changes = {
      'recheck-redraw': ['if wasShown && visible && shown,', 'if false && wasShown && visible && shown,'],
      'dump-assumes-visible': ['perch.receiveVisible(perchEvent(plan), now: time, env: env, visible: panelVisible)', 'perch.receiveVisible(perchEvent(plan), now: time, env: env, visible: perch.shown)'],
      'quiet-hides': ['if monitor.isActive(clock) {', 'if !monitor.isActive(clock) {'],
      'parked-faster-poll': ['asleep || !shown || paused ? 2 : 0.2', 'asleep || !shown || paused ? 0.2 : 0.2'],
      'paused-idle-deadline': ['paused ? nil : lastFrame + (event?.state == "waiting" ? 120 : 20)', 'lastFrame + (event?.state == "waiting" ? 120 : 20)'],
    };
    const [before, after] = changes[process.env.CHV4C_BROKEN];
    assert.ok(text.includes(before)); writeFileSync(compileSource, text.replace(before, after));
  }
  const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), compileSource, '-o', output], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr); binary = output; return binary;
}
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const keys = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = (more = {}) => ({ hand: 'character', nonce, seq: 1, id: 'fixture', sheet: '/tmp/stage-fixture/sheet.png', extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } }, perch: { anchor: [96, 150], table: Object.fromEntries(keys.map(k => [k, entry])) }, size: 'stage', ...more });
const win = (frame = [200, 500, 900, 350], more = {}) => ({ id: 7, pid: 42, frame, ...more });
const world = (windows = [win()], more = {}) => ({ dumpWorld: { windows, displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
  pointer: [1750, 1150], inputAge: 20, pointerAway: 10, person: [1450, 700, 300, 300], cards: [], ...more } });
let seq = 10;
const aim = (at = [650, 700], more = {}) => ({ hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: 42, windowId: 7, at, ...more });
const clock = time => ({ dumpClock: time });
const standingCharacter = () => character({ size: 'medium', perch: { anchor: [96, 208], table: Object.fromEntries(keys.map(k => [k, entry])) } });
const climbWorld = (above = []) => world([...above, win([500, 30, 600, 2600])], {
  person: [1500, 100, 200, 200], pointer: [1750, 2950],
  displays: [{ frame: [0, 0, 1800, 3000], visible: [0, 30, 1800, 2940] }],
  cards: [[1100, 0, 200, 3000], [280, 0, 220, 350]],
});
function dump(lines, { frame = character(), art = true, reduced = false, ok = 0, throughRing = false } = {}) {
  const r = spawnSync(host(), ['--stage-dump', ...reduced ? ['--reduce-motion'] : [], ...throughRing ? ['--through-ring'] : []], {
    input: [frame, { dumpStageArt: art }, ...lines].map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000,
   killSignal: 'SIGKILL' });
  assertChildStatus(r, ok, r.stderr || r.stdout.slice(-2000));
  const rows = r.stdout.trim() ? r.stdout.trim().split('\n').map(JSON.parse) : [];
  for (const row of rows.filter(r => r.effect === 'stage-cost'))
    console.log('placement cost receipt ' + JSON.stringify({ aims: lines.filter(l => l.hand === 'aim').length, ...row }));
  return rows;
}
const draws = rows => rows.filter(r => r.effect === 'stage');
const latest = rows => draws(rows).at(-1);
const overlaps = (a, b) => a[0] < b[0] + b[2] - 1e-7 && a[0] + a[2] > b[0] + 1e-7 && a[1] < b[1] + b[3] - 1e-7 && a[1] + a[3] > b[1] + 1e-7;
const expand = (a, n) => [a[0] - n, a[1] - n, a[2] + 2 * n, a[3] + 2 * n];
function assertWideSeat(row, frames = [win().frame]) {
  assert.equal(row.shown, true, 'retained wide protection permits a clear screen-edge seat');
  assert.ok(row.wideWindows.length > 0);
  assert.ok(['edge-hang', 'floor-stand'].includes(row.presented.seat.kind));
  for (const frame of frames) {
    const area = expand(frame, 48);
    assert.ok(row.forbidden.some(r => r[0] <= area[0] && r[1] <= area[1] &&
      r[0] + r[2] >= area[0] + area[2] && r[1] + r[3] >= area[1] + area[3]), 'old window frame remains protected');
  }
  assert.ok(row.forbidden.every(r => !overlaps(row.presented.box, r)), 'edge seat clears every retained area');
}

describe('native stage geometry', { skip: macCommandSkip('xcrun') }, () => {

test('CHV4C legacy stage dump keeps stable installs across 120 seconds with a quiet recheck and receive replay', t => {
  const paused = { hand: 'status', nonce, seq: 2, state: 'paused', pid: 42, windowId: 7, at: [650, 700] };
  const input = [character({ size: 'small' }), world(), paused, clock(1),
    { ...paused, seq: 3 }, { dumpStats: true }, clock(60), { dumpCallSample: 'quiet' },
    { ...paused, seq: 4 }, clock(121), { dumpStats: true }];
  const run = spawnSync(host(), ['--stage-dump', '--legacy-perch', '--reduce-motion'], {
    input: input.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 << 20, timeout: 15000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  const rows = run.stdout.trim().split('\n').map(JSON.parse), snapshots = rows.filter(r => r.effect === 'legacy-stats'), stats = snapshots.at(-1);
  assert.equal(snapshots[0].installCount, 2); assert.equal(stats.installCount, snapshots[0].installCount); assert.equal(stats.quietRechecks, 1); assert.equal(stats.shown, true);
  assert.equal(stats.time, 121); assert.equal(stats.panelVisible, true); assert.equal(stats.callMonitor.lastSuccessfulState, 'quiet');
  assert.equal(rows.filter(r => r.effect === 'perch-hide').length, 0);
  assert.deepEqual(stats.wakeCounts, { 'legacy-window-check': 59, 'legacy-timer:park': 3 });
  assert.equal(stats.poll, 2);
  t.diagnostic('CHV4C parked clock receipt ' + JSON.stringify(stats));
});

test('CHV4N dump uses the panel visibility independently of the runtime shown flag', () => {
  const paused = { hand: 'status', nonce, seq: 2, state: 'paused', pid: 42, windowId: 7, at: [650, 700] };
  const input = [character({ size: 'small' }), world(), paused, clock(1), { ...paused, seq: 3 },
    clock(2), { dumpPanelVisible: false }, { dumpStats: true }, { ...paused, seq: 4 }, { dumpStats: true }];
  const run = spawnSync(host(), ['--stage-dump', '--legacy-perch', '--reduce-motion'], {
    input: input.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
  const [before, after] = run.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'legacy-stats');
  assert.equal(before.shown, true); assert.equal(before.panelVisible, false);
  assert.equal(after.panelVisible, true); assert.equal(after.installCount, before.installCount + 1);
});

test('CHV4C legacy stage dump preserves confirmed-call visibility through pending and failures', () => {
  for (const initial of [false, true]) {
    const lines = [character({ size: 'small' }), world(),
      { hand: 'status', nonce, seq: 2, state: 'paused', pid: 42, windowId: 7, at: [650, 700] },
      ...initial ? [{ dumpCallSample: 'input-active' }] : [],
      { dumpCallSample: 'pending' }, clock(60), { dumpCallSample: 'timeout' }, clock(90),
      { dumpCallSample: 'unavailable' }, clock(120), { dumpStats: true }, { dumpCallSample: 'quiet' }, { dumpStats: true }];
    const run = spawnSync(host(), ['--stage-dump', '--legacy-perch', '--reduce-motion'], {
      input: lines.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' });
    assertChildStatus(run, 0, run.stderr);
    const stats = run.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'legacy-stats');
    assert.equal(stats[0].shown, !initial); assert.equal(stats[1].shown, true);
  }
});

test('CHV4F stage scheduler reports each parked wake across 120 seconds without windows', t => {
  for (const size of ['medium', 'stage']) {
    const rows = dump([{ dumpSchedule: true }, world(), aim(), { dumpPaused: true }, clock(120), { dumpStats: true }],
      { frame: character({ size, stageAttention: false }), reduced: true });
    const stats = rows.findLast(r => r.effect === 'stage-stats');
    assert.equal(stats.shown, true); assert.equal(stats.poll, 2);
    assert.deepEqual(stats.wakeCounts, { 'stage-window-check': 60 });
    t.diagnostic('CHV4F ' + size + ' parked wakes ' + JSON.stringify(stats.wakeCounts));
  }
});

test('CHV4Q paused stage skips the unused sleep deadline between fallback checks', t => {
  for (const size of ['medium', 'stage']) {
    const rows = dump([{ dumpSchedule: true }, world(),
      { hand: 'status', nonce, seq: 2, state: 'paused', pid: 42, windowId: 7, at: [650, 700] },
      clock(1), { dumpStats: true }, clock(62), { dumpStats: true }],
      { frame: character({ size, stageAttention: false }), reduced: true });
    const [before, after] = rows.filter(row => row.effect === 'stage-stats');
    assert.equal(after.shown, true); assert.equal(after.poll, 2);
    assert.deepEqual(after.wakeCounts, { 'stage-window-check': 30 });
    assert.equal(before.planBegan, after.planBegan, 'the parked pose keeps its clock');
    t.diagnostic('CHV4Q ' + size + ' 61 s receipt ' + JSON.stringify(after.wakeCounts));
  }
});

test('CA6E cost seating shows with no person window and keeps the owned stand-in clear at stage size', () => {
  const fixture = readFileSync(new URL('../bench/hand/stage-fixture.swift', import.meta.url), 'utf8');
  assert.match(fixture, /stageBenchPersonWindow = StageWindowKey/, 'the cost fixture must supply its own person window');
  const windows = [win([30, 592, 710, 350]), win([772, 592, 710, 350], { id: 8 })];
  const layout = more => world(windows, { displays: [{ frame: [0, 0, 1512, 982], visible: [0, 33, 1512, 949] }],
    pointer: [1508, 975], person: null, ...more });
  const rows = dump([layout(), aim([527, 837]), clock(0.1),
    layout({ person: [1272, 33, 220, 122] }), clock(0.5)], { throughRing: true });
  // Until 2026-11-09 a missing person window hid the character as "gone"; it now seats (front-app fix).
  assert.ok(!rows.some(r => r.hiddenReason === 'gone'), 'without a person window the character still seats');
  const shown = latest(rows);
  assert.ok(shown, 'the separate person window must permit seating');
  assert.equal(shown.rung, 'stage');
  assert.ok(!overlaps(shown.box, [1272, 33, 220, 122]), 'the stand-in remains protected');
});

test('CHV2X one quiet reading stays shown across two-second parked clock steps with one panel generation', () => {
  const lines = [world(), aim(), clock(20), { dumpCallSample: 'quiet' }];
  for (let time = 22; time <= 80; time += 2) lines.push(clock(time));
  const rows = dump(lines);
  assert.equal(rows.filter(r => r.effect === 'stage-hide').length, 0);
  assert.equal(rows.at(-1).panelGenerations, 1); assert.equal(rows.at(-1).shown, true);
});

test('CHV2X every size shows pending and timeout but hides a confirmed live microphone', () => {
  for (const size of ['small', 'medium', 'stage']) {
    const options = { frame: character({ size }) };
    for (const state of ['pending', 'timeout', 'unavailable']) {
      const rows = dump([world(), { dumpCallSample: state }, aim()], options);
      assert.ok(draws(rows).length > 0, size + ' ' + state + ' stays shown at startup');
      assert.equal(rows.at(-1).shown, true);
      assert.equal(rows.findLast(r => r.effect === 'call-sample').callMonitor.state, state);
    }
    const active = dump([world(), aim(), clock(0.1), { dumpActivity: { call: true } }], options);
    assert.equal(active.at(-1).shown, false, size + ' active microphone must hide');
    assert.equal(active.at(-1).hiddenReason, 'call');
    const reading = dump([world(), aim(), { dumpCallSample: 'input-active' }], options);
    assert.equal(reading.at(-1).shown, false); assert.equal(reading.at(-1).hiddenReason, 'call');
    const timeout = dump([world(), { dumpCallSample: 'quiet' }, aim(), clock(0.1), { dumpCallSample: 'timeout' }], options);
    assert.ok(draws(timeout).length > 0); assert.equal(timeout.at(-1).shown, true, size + ' timeout retains quiet');
  }
});

test('CHV2X failures and slow queries retain live until a successful quiet reading at every size', () => {
  for (const size of ['small', 'medium', 'stage']) {
    for (const state of ['pending', 'timeout', 'unavailable']) {
      const lines = [world(), aim(), { dumpCallSample: 'input-active' }, clock(0.1), { dumpCallSample: state }, clock(60)];
      const held = dump(lines, { frame: character({ size }) });
      assert.equal(held.at(-1).shown, false); assert.equal(held.at(-1).hiddenReason, 'call');
      const clear = dump([...lines, { dumpCallSample: 'quiet' }], { frame: character({ size }) });
      assert.equal(clear.at(-1).shown, true);
      assert.equal(latest(clear).rung, size);
    }
  }
  dump([world(), aim(), clock(2), clock(1)], { ok: 65 });
});

test('CHV2X stage rung returns after a call hide clears', () => {
  const rows = dump([world(), aim(), { dumpActivity: { call: true } }, clock(0.1), { dumpActivity: { call: false } }]);
  assert.ok(rows.some(r => r.effect === 'stage-hide' && r.reason === 'call'));
  assert.equal(latest(rows).rung, 'stage'); assert.equal(rows.at(-1).shown, true);
});

test('non-bench host contains no pointer input shim or fixture receipt strings', () => {
  const strings = spawnSync('/usr/bin/strings', ['-a', host()], {
    encoding: 'utf8', maxBuffer: 16 << 20, timeout: 20000, killSignal: 'SIGKILL',
  });
  assertChildStatus(strings, 0, strings.stderr);
  assertStagePointerStrings(strings.stdout, false);
  assert.throws(() => assertStagePointerStrings(strings.stdout, true));
});


test('CHRET2 independent obligations protect lifecycle, content and late-completion schedules', { timeout: 900000 }, t => {
  const result = runStageObligationFuzz(host(), { frame: standingCharacter(), cases: process.env.CHRET2_BROKEN_VARIANT ? 8 : 248 });
  assert.deepEqual(result.violations, [], 'obligation oracle: ' + JSON.stringify(result));
  assert.equal(result.stats.intersections, 0);
  assert.ok(result.stats.visible > 0 && result.stats.pairs > 0, 'non-vacuous presented panel and obligation pairs');
  assert.equal(result.stats.terminalReleases, result.stats.cases);
  assert.equal(result.distinctSequences, result.stats.cases, 'distinct scripts, not repeated seeds');
  t.diagnostic('CHRET2 obligations ' + JSON.stringify(result));
});

test('CHRET2 the pointer exclusion stays clear at nonzero opacity when a dodge cannot fit', () => {
  const window = win([200, 500, 300, 350]), frame = character({ size: 'medium' });
  const initial = latest(dump([world([window]), aim([350, 700])], { frame }));
  const pointer = [initial.box[0] + 80, initial.box[1] + 80];
  const rows = dump([world([window]), aim([350, 700]), clock(1), world([window], { pointer, inputAge: 0 })], { frame });
  assert.equal(rows.at(-1).shown, false, 'pointer exclusion cannot keep a visible fade');
  assert.equal(rows.at(-1).hiddenReason, 'pointer-covered');
  assert.equal(rows.findLast(r => r.effect === 'stage-hide').duration, 0);
  assert.equal(rows.findLast(r => r.effect === 'stage-hide').panelOnScreen, false);
});

test('recorded hide state comes from the released production panel without a test pin', () => {
  const window = win([200, 500, 300, 350]), frame = character({ size: 'medium' });
  const initial = latest(dump([world([window]), aim([350, 700])], { frame }));
  assert.equal(initial.panelOnScreen, true, 'draw installed a visible panel');
  const pointer = [initial.box[0] + 80, initial.box[1] + 80];
  const rows = dump([world([window]), aim([350, 700]), clock(1), world([window], { pointer, inputAge: 0 })], { frame });
  const hidden = rows.findLast(r => r.effect === 'stage-hide');
  assert.equal(hidden.reason, 'pointer-covered');
  assert.equal(hidden.panelOnScreen, false, 'production hide released the panel');
  assert.equal(Object.hasOwn(hidden, 'opacity'), false);
  for (const input of [{ dumpPanelAlpha: 1 }, { panelOnScreen: false }, { dumpPanelOnScreen: false }])
    dump([world([window]), aim([350, 700]), input], { frame, ok: 65 });
});

test('CHRET4 pointer-covered needs 300 ms continuously clear with a 56 pt exit margin', () => {
  const window = win([200, 500, 300, 350]), frame = character({ size: 'medium' });
  const old = latest(dump([world([window]), aim([350, 700])], { frame })).box;
  const covered = [old[0] + 80, old[1] + 80], far = [1750, 1150];
  const rows = dump([world([window]), aim([350, 700]), clock(1), world([window], { pointer: covered }),
    clock(1.1), world([window], { pointer: far }), { dumpStats: true },
    clock(1.2), world([window], { pointer: covered }),
    clock(1.3), world([window], { pointer: far }), { dumpStats: true },
    clock(1.599), { dumpStats: true }, clock(1.601), { dumpStats: true }], { frame });
  const samples = rows.filter(r => r.effect === 'stage-stats');
  assert.equal(samples[0].shown, false, 'pointer recovery must dwell');
  assert.equal(samples[1].shown, false, 'pointer jitter restarts the clear dwell');
  assert.equal(samples[2].shown, false, '299 ms cannot restore the drawing');
  assert.equal(samples[3].shown, true, '301 ms clear restores a safe drawing');
});

test('CHRET4 pointer-covered keeps the exit margin until the whole candidate clears 56 pt', () => {
  const window = win([200, 500, 300, 350]), frame = character({ size: 'medium' });
  const old = latest(dump([world([window]), aim([350, 700])], { frame })).box;
  const covered = [old[0] + 80, old[1] + 80], far = [1750, 1150];
  const edge = [old[0] + old[2] + 45, old[1] + old[3] / 2];
  const rows = dump([world([window]), aim([350, 700]), clock(1), world([window], { pointer: covered }),
    clock(1.1), world([window], { pointer: far }), clock(1.2), world([window], { pointer: edge }), clock(1.5), { dumpStats: true },
    clock(1.8), world([window], { pointer: far }), clock(2.099), { dumpStats: true }, clock(2.101), { dumpStats: true }], { frame });
  const samples = rows.filter(r => r.effect === 'stage-stats');
  assert.equal(samples[0].shown, false, '45 pt clearance cannot release the 56 pt exit margin');
  assert.equal(samples[1].shown, false, 'a near-edge sample resets clear dwell');
  assert.equal(samples[2].shown, true);
});

test('CHRET2 semantic contributors survive containment and keep bounds separate from content', () => {
  const first = aim([650, 700], { rect: [600, 650, 100, 100] }), second = aim([650, 700], { rect: [550, 600, 200, 200] });
  const scroll = { hand: 'act', nonce, seq: ++seq, kind: 'scroll', pid: 42, windowId: 7, at: [650, 700], path: [[650, 700]], delayMs: 0, beats: 1 };
  const stats = dump([world(), first, second, { dumpStats: true }, scroll, { dumpStats: true }]).filter(r => r.effect === 'stage-stats');
  assert.ok(stats[0].targetBindings.some(b => [first.seq, second.seq].every(seq => b.contributors.some(c => c.seq === seq))), 'semantic provenance lost through containment');
  const before = stats[0].targetBindings[0], after = stats[1].targetBindings.find(b => b.contributors.some(c => c.seq === scroll.seq));
  assert.equal(after.generation, before.generation, 'scroll must not invent new bounds');
  assert.equal(after.contentGeneration, before.contentGeneration + 1, 'content generation must change on scroll');
  assert.ok(stats[1].targetBindings.some(b => b.contributors.some(c => c.seq === first.seq)), 'old content still protected');
  assertWideSeat(stats[1]);
  assert.equal(stats[1].targetUnmapped, true, 'visibility does not certify the scroll mapping');
});

test('CA4 provenance pressure widens at 513 contributors without losing geometry', () => {
  const actions = Array.from({ length: 513 }, () => aim([650, 800]));
  const rows = dump([world(), ...actions.slice(0, 512), { dumpStats: true }, actions[512], { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assert.equal(stats[0].turnTargets, 1); assert.equal(stats[0].contributors, 512);
  assert.equal(stats[0].targetCapacity, false); assert.equal(stats[1].targetCapacity, false);
  assert.ok(stats[1].contributors <= 512);
  assert.equal(stats[1].wideRecords.length, 1);
  assert.ok(stats[1].forbidden.some(r => r[0] <= 152 && r[1] <= 452 && r[0] + r[2] >= 1148 && r[1] + r[3] >= 898));
  assert.equal(rows.some(r => r.reason === 'target-capacity'), false);
});

test('CA4 window identity overflow hides immediately', () => {
  const lines = [];
  for (let i = 1; i <= 130; i++) lines.push(world([{ ...win(), id: i }]), aim([650, 800], { windowId: i }));
  const rows = dump([...lines, { dumpStats: true }]);
  assert.equal(rows.at(-2).shown, false, 'window overflow must hide immediately');
  assert.equal(rows.at(-2).hiddenReason, 'target-capacity', 'window overflow must hide immediately');
  assert.ok(rows.filter(r => r.reason === 'target-capacity').every(r => r.duration === 0));
});

test('CHRET2 rejects an old sequence terminal after a new turn admission', () => {
  const a = aim(), oldDone = { hand: 'status', nonce, seq: a.seq + 1, state: 'done', pid: 42, windowId: 7, at: [650, 700] };
  const b = aim(); b.seq = a.seq + 2;
  const reader = spawnSync(host(), ['--channels-selftest', '--hand', '--cursor-style=ring'], {
    input: [a, oldDone, b, oldDone].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(reader, 65, 'production reader must reject an old completion');
  dump([world(), a, oldDone, b, oldDone], { ok: 65 });
});

test('CHRET2 captured transactions reproduce targets, hide transitions and art readiness exactly', async t => {
  const { installStageCharacter } = await import('../bench/hand/stage-live.mjs');
  const { stageSequence } = await import('../bench/hand/stage-cost.mjs');
  const { cursorWire } = await import('../bench/hand/cursor-sequence.mjs');
  const { stageReplayReceipt, stageReplayLines, compareStageReplay, stageTraceFigures } = await import('../bench/hand/stage-trace.mjs');
  const frame = { ...installStageCharacter(folder).frame, seq: 0, size: 'stage', stageAttention: false };
  const windows = [win([100, 600, 500, 250]), { ...win([900, 600, 500, 250]), id: 9 }];
  for (const stress of [false, true]) {
    const wire = cursorWire(nonce); wire.aim({ kind: 'click', pid: 1, windowId: 1, at: [0, 0] });
    const sequence = stageSequence(windows.map(w => ({ ...w, bounds: { x: w.frame[0], y: w.frame[1], width: w.frame[2], height: w.frame[3] } })), { stress });
    const lines = [world(windows), { dumpSyntheticArt: 'pending' },
      JSON.parse(wire.aim({ kind: 'click', pid: 42, windowId: 7, at: [450, 800] }))];
    const operations = sequence.steps.map(step => ({ at: step.atMs / 1000, frame: JSON.parse(wire[step.type](step.args)) }));
    operations.push({ at: 0.2, frame: { dumpSyntheticArt: 'ready' } },
      { at: 20.1, frame: world(windows, { person: [1500, 950, 100, 100], pointer: [1790, 1180] }) });
    operations.sort((a, b) => a.at - b.at);
    for (const op of operations) lines.push(clock(op.at), op.frame);
    lines.push(clock(61));
    const trace = collectStageTrace(dump(stageTraceLines(lines), { frame, throughRing: true }));
    const receipt = stageReplayReceipt({ frame, trace, scenario: sequence.scenario });
    const transactions = stageReplayLines(receipt).slice(1).filter(r => !r.dumpTrace && !r.dumpTraceRead);
    const actual = collectStageTrace(dump(stageTraceLines(transactions), { frame }));
    assert.deepEqual(compareStageReplay(trace, actual).mismatches, [], 'trace counts or hide transitions changed');
    assert.deepEqual(actual.records.map(r => r.output), trace.records.map(r => r.output), 'trace plans changed');
    assert.ok(trace.records.some(r => r.input.art?.some(a => a.pose?.pending === true)));
    const audit = auditStageTrace(trace);
    assert.deepEqual(audit.errors, [], 'captured trace protected intersections');
    const figures = stageTraceFigures(trace, { start: 0, end: 61, sampleTimes: Array.from({ length: 62 }, (_, i) => i) });
    assert.equal(figures.sampleCount, 62);
    t.diagnostic(`CHRET2 trace stress=${stress} actions=40 records=${trace.records.length} bytes=${trace.bytes} exact=true figures=${JSON.stringify(figures)} audit=${JSON.stringify(audit)}`);
  }
});

test('every CHRET2 broken variant fails its named behavior assertion', { skip: !!process.env.CHRET2_BROKEN_VARIANT, timeout: 900000 }, t => {
  const oracle = 'CHRET2 independent obligations protect lifecycle, content and late-completion schedules';
  const semantic = 'CHRET2 semantic contributors survive containment and keep bounds separate from content';
  const expected = {
    'visible-pointer-fade': ['CHRET2 the pointer exclusion stays clear at nonzero opacity when a dodge cannot fit', /pointer exclusion cannot keep a visible fade/],
    'timeout-only-deletion': [oracle, /lost contributor/],
    'count-only-eviction': [oracle, /lost contributor/],
    'completion-as-consumption': [oracle, /lost contributor/],
    'missing-window-identity': [oracle, /lost contributor/],
    'discarded-drag-typing-pins': [oracle, /lost contributor/],
    'dropped-admission-acknowledgement': [oracle, /lost contributor/],
    'accepting-old-turn-completion': ['CHRET2 rejects an old sequence terminal after a new turn admission', /child: 0/],
    'discarded-coalesced-contributor': [semantic, /semantic provenance lost through containment/],
    'bounds-as-content-generation': [semantic, /content generation must change on scroll/],
    'missing-capacity-hide': ['CA4 window identity overflow hides immediately', /window overflow must hide immediately/],
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(STAGE_BROKEN_VARIANTS).sort());
  for (const [name, [testName, message]] of Object.entries(expected)) {
    const env = { ...process.env, CHRET2_BROKEN_VARIANT: name }; delete env.NODE_TEST_CONTEXT;
    const pattern = '^' + testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=900000', '--test-name-pattern=' + pattern, new URL(import.meta.url).pathname], {
      encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL',
    });
    assert.equal(r.status, 1, `${name}: expected a failing behavior test: ${r.stderr} ${r.stdout}`);
    assert.doesNotMatch(r.stdout + r.stderr, /error: (?:cannot|expected|consecutive|value|type)|child: (?:ETIMEDOUT|SIGKILL)|host exit/, `${name}: host failure is not detection`);
    assert.ok(r.stdout.includes('not ok 1 - ' + testName), `${name}: wrong failing test: ${r.stdout}`);
    assert.match(r.stdout, /ERR_ASSERTION/); assert.match(r.stdout, message, `${name}: wrong assertion`);
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'skipped'].map(key =>
      [key, Number(new RegExp('#\\s+' + key + '\\s+(\\d+)').exec(r.stdout)?.[1])]));
    assert.equal(counts.tests, 1); assert.equal(counts.fail, 1); assert.equal(counts.pass, 0);
    t.diagnostic(`brokenVariant=${name} exit=${r.status} test=${testName} counts=${JSON.stringify(counts)}`);
  }
});

test('CR1A dump preserves exclusions through call done and reports every hide before turn end', () => {
  const blockedEdges = { cards: [[0, 30, 1800, 110], [0, 1060, 1800, 110]] };
  const start = aim([650, 700], { rect: [200, 500, 900, 350] });
  const done = ok => ({ hand: 'status', nonce, seq: ++seq, state: 'done', pid: 42, windowId: 7, at: [650, 700], ...(ok ? { ok: true } : {}) });
  const rows = dump([world([win()], blockedEdges), start, { dumpStats: true }, done(true), { dumpStats: true }, clock(1), done(false), { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assert.equal(stats[0].turnTargets, 1); assert.equal(stats[1].turnTargets, 1);
  assert.equal(stats[0].hiddenReason, 'no-seat'); assert.equal(stats[1].hiddenReason, 'no-seat');
  assert.equal(stats[2].turnTargets, 0); assert.equal(stats[2].hiddenReason, null);
  assert.equal(rows.at(-1).shown, true);
  assert.ok(rows.filter(r => r.effect === 'stage-hide').every(r => r.reason === 'no-seat' && r.turnTargets === 1));
  assert.ok(rows.every(r => Number.isInteger(r.turnTargets)));
});

test('CR2A live ring path forwards call done followed by turn done at the same point', async t => {
  const { stageSequence } = await import('../bench/hand/stage-cost.mjs');
  const { cursorWire } = await import('../bench/hand/cursor-sequence.mjs');
  const windows = [win([30, 592, 968, 350]), { id: 8, pid: 42, frame: [500, 592, 968, 350] }];
  for (const stress of [false, true]) {
    const sequence = stageSequence(windows.map(w => ({ ...w, bounds: { x: w.frame[0], y: w.frame[1], width: w.frame[2], height: w.frame[3] } })), { stress });
    const wire = cursorWire(nonce); wire.aim({ pid: 42, windowId: 7, kind: 'click', at: [0, 0] });
    const lines = [world(windows)];
    for (const step of sequence.steps) {
      lines.push(clock(step.atMs / 1000), JSON.parse(wire[step.type](step.args)), { dumpStats: true });
    }
    const rows = dump(lines, { throughRing: true, frame: character({ seq: 0 }) });
    const stats = rows.filter(r => r.effect === 'stage-stats');
    assert.ok(Math.max(...stats.map(r => r.turnTargets)) > 1, 'targets accumulated before completion');
    assert.ok(stats.at(-1).targetBindings.every(t => t.rect[2] <= 96 && t.rect[3] <= 96), 'no earlier broad target survives turn end');
    assert.equal(stats.at(-1).shown, true, 'turn end permits re-seating');
    assert.equal(stats.at(-1).seq, sequence.steps.length, 'the final frame reached stage');
    t.diagnostic(`stress=${stress} frames=${sequence.steps.length} peakTargets=${Math.max(...stats.map(r => r.turnTargets))} finalTargets=${stats.at(-1).turnTargets}`);
  }
});

test('CR2A targets retain window and generation without moving old geometry to a replacement', () => {
  const a = win(), b = { id: 9, pid: 42, frame: [100, 600, 700, 400] };
  const first = aim([650, 700], { rect: [600, 650, 100, 100], windowRect: a.frame });
  const stats = lines => dump(lines).filter(r => r.effect === 'stage-stats');
  const same = stats([world([a, b]), first, aim([400, 850], { windowId: 9 }), { dumpStats: true }]);
  assert.equal(same[0].activeTargets, same[0].turnTargets, 'other live windows keep their exclusions for the turn');
  const moved = win([210, 500, 900, 350]);
  const rows = stats([world([a, b]), first, { dumpStats: true }, world([moved, b]), clock(1),
    aim([400, 850], { windowId: 9 }), { dumpStats: true },
    world([a, b]), aim([650, 700], { windowRect: a.frame }), { dumpStats: true }]);
  const original = rows[0].targetBindings.find(t => t.window === 7);
  assert.equal(original.pid, 42); assert.deepEqual(original.windowRect, a.frame);
  assert.ok(rows[1].activeTargets >= rows[1].turnTargets, 'retained generations and wide aggregates keep protecting');
  assert.ok(rows[1].targetBindings.some(t => t.generation === original.generation));
  assert.ok(rows[2].targetBindings.some(t => t.window === 7 && t.generation !== original.generation), 'move back starts a new generation');
  for (const replacement of [{ ...a, pid: 99 }, { ...a, id: 17 }]) {
    const closed = stats([world([a, b]), first, world([b]), world([replacement, b]),
      aim([650, 700], { pid: replacement.pid, windowId: replacement.id }), { dumpStats: true }]).at(-1);
    assert.ok(closed.activeTargets >= closed.turnTargets);
    assert.ok(closed.targetBindings.some(t => t.pid === replacement.pid && t.window === replacement.id));
  }
});

test('CR2B old full-window targets protect until a real turn end', () => {
  const blockedEdges = { cards: [[0, 30, 1800, 110], [0, 1060, 1800, 110]] };
  const old = win(), replacement = { ...win(), id: 9 };
  for (const next of [[replacement], [replacement, win([200, 900, 900, 200])]]) {
    const rows = dump([world([old], blockedEdges), aim([650, 700], { rect: old.frame, windowRect: old.frame }), { dumpStats: true },
      world(next, blockedEdges), aim([650, 700], { windowId: 9, windowRect: replacement.frame }), { dumpStats: true }]);
    const stats = rows.filter(r => r.effect === 'stage-stats');
    assert.equal(stats[0].hiddenReason, 'no-seat', 'the original full-window exclusion must constrain placement');
    assert.equal(stats[1].shown, false, 'old geometry keeps protecting even after window replacement');
    assert.ok(stats[1].activeTargets >= stats[1].turnTargets);
  }
});

test('CR2A delayed old geometry and fresh aims preserve the unresolved-position hold', () => {
  const a = win(), moved = win([210, 500, 900, 350]);
  const rows = dump([world([a]), aim([650, 700], { windowRect: a.frame }), world([moved]), clock(1),
    aim([650, 700], { windowRect: a.frame }), { dumpStats: true },
    aim([660, 700], { windowRect: moved.frame }), clock(2), { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assertWideSeat(stats[0], [a.frame, moved.frame]); assert.equal(stats[0].targetUnmapped, true);
  assert.equal(stats[0].hideReasonCounts['stale-window'], 0);
  assert.equal(stats[0].maxWindowBoundsDifferencePt, 10);
  assertWideSeat(stats[1], [a.frame, moved.frame]);
  assert.ok(stats[1].targetBindings.some(t => JSON.stringify(t.windowRect) === JSON.stringify(moved.frame)));
});

test('CR2C hide counters count transitions, including re-entry and reason changes', () => {
  const a = win(), moved = win([210, 500, 900, 350]);
  const rows = dump([world([a]), aim([650, 700], { windowRect: a.frame }),
    world([moved]), clock(0.2), clock(0.4), clock(0.6), { dumpStats: true },
    world([]), clock(0.8), clock(1), { dumpStats: true },
    world([moved]), clock(1.2), clock(1.4), { dumpStats: true },
    aim([660, 700], { windowRect: moved.frame }), clock(2), { dumpStats: true },
    aim([650, 700], { windowRect: a.frame }), clock(2.2), { dumpStats: true }]);
  const stats = rows.filter(row => row.effect === 'stage-stats');
  assert.equal(stats[0].hideReasonCounts['stale-window'], 0);
  assert.equal(stats[1].hideReasonCounts.gone ?? 0, 0);
  assertWideSeat(stats[1], [a.frame, moved.frame]);
  assert.equal(stats[2].hideReasonCounts['stale-window'], 0);
  assertWideSeat(stats[3], [a.frame, moved.frame]);
  assert.equal(stats[4].hideReasonCounts['stale-window'], 0);
});

test('CR2C bounds maximum is null before comparison and ignores tolerated differences', () => {
  const a = win(), tolerated = win([200.005, 500, 900, 350]), moved = win([210, 500, 900, 350]);
  const stats = dump([world([a]), aim(), { dumpStats: true },
    aim([650, 700], { windowRect: a.frame }), { dumpStats: true },
    world([tolerated]), clock(0.2), { dumpStats: true },
    world([moved]), clock(0.4), { dumpStats: true },
    aim([660, 700], { windowRect: moved.frame }), clock(1), { dumpStats: true }])
    .filter(row => row.effect === 'stage-stats');
  assert.equal(stats[0].maxWindowBoundsDifferencePt, null);
  assert.equal(stats[1].maxWindowBoundsDifferencePt, 0, 'an exact comparison is measured zero');
  assert.equal(stats[2].maxWindowBoundsDifferencePt, 0, 'tolerated geometry did not cause stale-window');
  assert.notEqual(stats[3].hiddenReason, 'stale-window');
  assert.equal(stats[3].maxWindowBoundsDifferencePt, 10);
  assert.equal(stats[4].maxWindowBoundsDifferencePt, 10, 'later exact comparisons retain the session maximum');
});

test('CR2A authored stage reactions survive 5 Hz observations and finish their last cell', async t => {
  const { installStageCharacter } = await import('../bench/hand/stage-live.mjs');
  const frame = { ...installStageCharacter(folder).frame, seq: 1, size: 'stage', stageAttention: false };
  const shots = new Set(['stage-lie-reach', 'stage-wince', 'stage-handoff', 'stage-cheer', 'stage-startle']);
  for (const [name, e] of Object.entries(frame.stage.table)) if (shots.has(name)) { e.loop = false; e.ms = [100, 100, 100, 100, 100, 100]; }
  const status = (state, more = {}) => ({ hand: 'status', nonce, seq: ++seq, state, pid: 42, windowId: 7, at: [650, 800], ...more });
  const act = kind => ({ hand: 'act', nonce, seq: ++seq, kind, pid: 42, windowId: 7, at: [650, 800], path: [[650, 800]], beats: 1, delayMs: 0 });
  for (const [kind, source] of [['click', 'stage-lie-reach'], ['key', 'stage-lie-reach'], ['error', 'stage-wince'],
    ['handback', 'stage-handoff'], ['type', 'stage-lie-peek'], ['waiting', 'stage-wait'], ['thinking', 'stage-think']]) {
    const rows = dump([world(), { dumpSyntheticArt: 'ready' }, ['click', 'key', 'type'].includes(kind) ? act(kind) : status(kind),
      clock(0.2), clock(0.4), clock(0.599), { dumpStats: true }, clock(0.6), clock(0.8)], { frame });
    const before = draws(rows).filter(r => r.time < 0.6);
    assert.equal(before.length, 1, `${kind} must not restart on an observer tick`);
    assert.equal(before[0].artSource, source, kind);
    assert.ok(before[0].cells.some(c => c[4] === 5), `${kind} reaches the last cell`);
    if (['click', 'key', 'error', 'handback'].includes(kind)) {
      assert.equal(latest(rows).artSource, 'stage-lie', kind);
      assert.equal(draws(rows)[1].time, 0.6, `${kind} includes the last cell's hold`);
    } else assert.equal(draws(rows).length, 1, `${kind} remains its real semantic state`);
  }
  const done = dump([world(), { dumpSyntheticArt: 'ready' }, act('click'), clock(0.1), status('done', { ok: true }),
    clock(0.2), clock(0.4), clock(0.6), status('done'), clock(0.8), clock(1.19), clock(1.2)], { frame, throughRing: true });
  assert.ok(draws(done).some(r => r.artSource === 'stage-cheer'));
  assert.equal(draws(done).filter(r => r.artSource === 'stage-lie-reach').length, 1, 'call completion does not restart the action response');
  assert.equal(latest(done).artSource, 'stage-lie');
  const reading = dump([world(), { dumpSyntheticArt: 'ready' }, status('error'), clock(0.1), status('thinking'),
    clock(0.2), clock(0.599), clock(0.6)], { frame });
  assert.equal(draws(reading).filter(r => r.artSource === 'stage-wince').length, 1);
  assert.equal(latest(reading).artSource, 'stage-think'); assert.equal(latest(reading).time, 0.6);
  const paused = dump([world(), { dumpSyntheticArt: 'ready' }, aim([650, 800], { rect: [200, 500, 900, 350] }),
    { dumpPaused: true }, clock(1), status('done'), clock(2), { dumpPaused: false },
    clock(2.2), clock(2.599), clock(2.6)], { frame, throughRing: true });
  const handoff = draws(paused).filter(r => r.artSource === 'stage-handoff');
  assert.equal(handoff.length, 1); assert.equal(handoff[0].time, 2);
  assert.ok(handoff[0].cells.some(c => c[4] === 5)); assert.equal(latest(paused).artSource, 'stage-lie');
  assert.equal(latest(paused).time, 2.6, 'the paused interval does not consume a one-shot that has not played');
  t.diagnostic('semanticCases=10 observerHz=5 oneShotMs=600 unchangedTickInstalls=0');
});

test('CR2A cold and failed art preserve the semantic response until its playable timeline completes', async () => {
  const { installStageCharacter } = await import('../bench/hand/stage-live.mjs');
  const frame = { ...installStageCharacter(folder).frame, seq: 1, size: 'stage', stageAttention: false };
  frame.stage.table['stage-wince'].loop = false;
  const error = { hand: 'status', nonce, seq: ++seq, state: 'error', pid: 42, windowId: 7, at: [650, 800] };
  const rows = dump([world(), { dumpSyntheticArt: 'pending' }, error, clock(1), clock(2), { dumpSyntheticArt: 'ready' },
    clock(2.2), clock(2.4), clock(2.79), clock(2.8)], { frame });
  const warm = draws(rows).find(r => r.artSource === 'stage-wince');
  assert.equal(warm.time, 2.2); assert.equal(latest(rows).artSource, 'stage-lie');
  assert.equal(draws(rows).findLast(r => r.artSource === 'stage-wince').time, 2.2);
  const failed = dump([world(), { dumpSyntheticArt: 'pending' }, error, clock(1), { dumpSyntheticArt: 'failed' },
    clock(1.2), clock(6.2)], { frame });
  assert.notEqual(latest(failed).artSource, 'error', 'failed decode completes its A2 response instead of waiting forever');
});

test('CR2A real movement and wake select authored travel and startle strips', async () => {
  const { installStageCharacter } = await import('../bench/hand/stage-live.mjs');
  const frame = { ...installStageCharacter(folder).frame, seq: 1, size: 'medium', stageAttention: false };
  const a = win([100, 600, 600, 400]), b = { id: 9, pid: 42, frame: [900, 600, 600, 400] };
  const rows = dump([world([a, b], { person: [1700, 1100, 80, 60] }), { dumpSyntheticArt: 'ready' }, aim([300, 900]),
    clock(1), aim([1300, 900], { windowId: 9 }), clock(1.2), clock(1.6), clock(21), aim([1300, 900], { windowId: 9 }),
    clock(21.2), clock(21.6), clock(22)], { frame });
  const transfer = draws(rows).find(r => r.time === 1);
  assert.equal(transfer.kind, 'far'); assert.equal(transfer.positions.length, 1);
  assert.notEqual(transfer.artSource, 'stage-leap', 'a panel spanning protected windows cannot claim a leap');
  assert.equal(draws(rows).findLast(r => r.time === 21).artSource, 'stage-startle');
  assert.equal(latest(rows).artSource, 'stage-lie');
  const unsafe = latest(dump([world([a, b], { person: [750, 100, 300, 300], pointer: [900, 200] }),
    { dumpSyntheticArt: 'ready' }, aim([300, 900]), clock(1), aim([1300, 900], { windowId: 9 })], { frame }));
  assert.equal(unsafe.kind, 'far');
  assert.ok(!['stage-leap', 'stage-run'].includes(unsafe.artSource), 'an unsafe sweep never claims travel art');
  const large = { ...frame, size: 'stage' }, wide = [win([100, 900, 900, 600]), { id: 9, pid: 42, frame: [1600, 900, 900, 600] }];
  const coldTravel = dump([world(wide, { person: [2800, 1200, 200, 200], pointer: [2950, 1750],
    displays: [{ frame: [0, 0, 3000, 1800], visible: [0, 30, 3000, 1740] }] }),
    { dumpSyntheticArt: { mode: 'ready', pending: ['stage-leap'] } }, aim([300, 1500]),
    clock(1), aim([2000, 1500], { windowId: 9 })], { frame: large });
  assert.equal(draws(coldTravel)[0].rung, 'stage', 'destination stage art starts ready');
  assert.ok(draws(coldTravel).every(r => r.artSource !== 'jumping'), 'a popped transfer does not request cold travel art');
  const tall = win([500, 30, 600, 2600]);
  const run = dump([world([tall], { person: [1500, 100, 200, 200], pointer: [1750, 2950],
    displays: [{ frame: [0, 0, 1800, 3000], visible: [0, 30, 1800, 2940] }],
    cards: [[1100, 0, 200, 3000], [280, 0, 220, 350]] }), { dumpSyntheticArt: 'ready' },
    aim([800, 500]), clock(1), aim([800, 2000]), clock(1.2), clock(1.6)], { frame });
  const running = draws(run).find(r => r.kind === 'run');
  assert.ok(running, 'a long clear same-window climb supplies a real run phase');
  assert.equal(running.artSource, 'stage-run');
  assert.ok(running.cells.every(c => c[1] === 'stage-run'));
  assert.ok(running.positions.at(-1)[0] <= 0.6);
  for (const p of draws(run)) for (const position of p.positions) {
    assert.equal(overlaps([position[1], position[2], p.box[2], p.box[3]], tall.frame), false);
  }
  const reduced = dump([world([a, b], { person: [1700, 1100, 80, 60] }), { dumpSyntheticArt: 'ready' }, aim([300, 900]),
    clock(1), aim([1300, 900], { windowId: 9 })], { frame, reduced: true });
  assert.ok(draws(reduced).every(r => !['stage-leap', 'stage-run', 'stage-startle'].includes(r.artSource)));
});

test('CR2A closed windows and paused drawing still receive turn completion', () => {
  const done = () => ({ hand: 'status', nonce, seq: ++seq, state: 'done', pid: 42, windowId: 7, at: [650, 700] });
  for (const extra of [[world([])], [{ dumpPaused: true }]]) {
    const rows = dump([world(), aim([650, 700], { rect: [200, 500, 900, 350] }), ...extra, done(), { dumpStats: true }], { throughRing: true });
    const stats = rows.filter(r => r.effect === 'stage-stats').at(-1);
    assert.equal(stats.turnTargets, 0);
    if (extra[0].dumpPaused) assert.equal(stats.shown, true, 'paused cleanup also releases the current broad aim rectangle');
  }
  const rows = dump([world(), aim(), { dumpStats: true }, world([]), world(), aim(), { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assert.ok(stats[1].targetBindings.some(t => t.generation === stats[0].targetBindings[0].generation));
  assert.ok(stats[1].targetBindings.some(t => t.generation !== stats[0].targetBindings[0].generation));
  assert.ok(stats[1].activeTargets >= stats[1].turnTargets, 'a visibility gap preserves every old obligation');
  const waiting = { hand: 'status', nonce, seq: ++seq, state: 'waiting', pid: 42, windowId: 7, at: [650, 700] };
  const resumed = dump([world(), waiting, { dumpPaused: true }, done(), { dumpPaused: false }, clock(0.2)], { throughRing: true });
  assert.ok(latest(resumed).states.includes('handoff'), 'resuming after turn end must not revive an approval wait');
});

test('CR2A distinct window generations cannot merge away retained targets at the bound', () => {
  const windows = Array.from({ length: 65 }, (_, i) => ({ ...win(), id: i + 1 }));
  const status = { hand: 'status', nonce, seq: seq + 100, state: 'done', pid: 42, windowId: 1, at: [650, 800] };
  const rows = dump([world(windows), ...windows.map(w => aim([650, 800], { windowId: w.id })), { dumpStats: true },
    status, { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assert.ok(stats[0].turnTargets <= 64); assert.equal(stats[0].activeTargets, 65);
  assertWideSeat(stats[0]); assert.equal(stats[0].targetCapacity, false);
  assert.ok(rows.filter(r => r.reason === 'target-capacity').every(r => r.duration === 0));
  assert.equal(stats[1].hiddenReason, null);
  assert.equal(new Set(stats[0].targetBindings.map(t => t.window)).size, 64);
  assert.equal(stats[1].turnTargets, 0);
});


test('CR2B restored windows separate incarnations and retain all old bounds until turn end', () => {
  const a = win(), b = { ...win([100, 600, 700, 400]), id: 9 };
  for (const absent of [{ ...a, minimized: true }, { ...a, onScreen: false }, null]) {
    const rows = dump([world([a, b]), aim([650, 700], { rect: [600, 650, 100, 100] }), { dumpStats: true },
      world([...(absent ? [absent] : []), b]), aim([400, 850], { windowId: 9 }), world([a, b]),
      aim([650, 700]), { dumpStats: true }]);
    const stats = rows.filter(r => r.effect === 'stage-stats');
    const first = stats[0].targetBindings.find(t => t.window === 7);
    assert.ok(stats[1].targetBindings.some(t => t.window === 7 && t.generation === first.generation));
    assert.ok(stats[1].targetBindings.some(t => t.window === 7 && t.generation !== first.generation));
    assertWideSeat(stats[1], [a.frame]);
    assert.ok(stats[1].activeTargets >= stats[1].turnTargets);
  }
});

test('CR2B a completed turn follows moved bounds without stale-window hiding', () => {
  const a = win(), moved = win([210, 500, 900, 350]);
  for (const throughRing of [false, true]) {
    const rows = dump([world(), aim([650, 700], { windowRect: a.frame }),
      { hand: 'status', nonce, seq: ++seq, state: 'done', pid: 42, windowId: 7, at: [650, 700], windowRect: a.frame },
      world([moved]), clock(1), clock(1.6), { dumpStats: true }], { throughRing });
    assert.equal(rows.filter(r => r.effect === 'stage-stats').at(-1).shown, true);
    assert.ok(!rows.some(r => r.reason === 'stale-window'));
  }
});

test('CR2B production HandHost ringFrame and receiveCursor release before drawing guards', () => {
  const r = spawnSync(host(), ['--pause-control-dump'], { input: JSON.stringify({ turnCompletionCheck: true }) + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual(result.turnTargets, [0, 0]);
  assert.deepEqual(result.measuredBounds, [false, false]);
  assert.equal(result.windows, 0);
  assert.deepEqual(result.receipts, Array.from({ length: 2 }, () => ({ hideReasonCounts: { 'stale-window': 1 }, maxWindowBoundsDifferencePt: 2.25 })));
});

test('CR2B no-seat cache ignores unrelated windows and invalidates retained-window changes', () => {
  const blockedEdges = { cards: [[0, 30, 1800, 110], [0, 1060, 1800, 110]] };
  const a = win(), unrelated = { ...win([1400, 100, 100, 100]), id: 90, pid: 99 };
  const rows = dump([world([a, unrelated], blockedEdges), aim([650, 700], { rect: a.frame }), { dumpStats: true },
    world([a, { ...unrelated, frame: [1401, 100, 100, 100] }], blockedEdges), { dumpStats: true },
    world([win([201, 500, 900, 350]), unrelated], blockedEdges), clock(1), { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assert.equal(stats[1].forbiddenBuilds, stats[0].forbiddenBuilds);
  assert.equal(stats[2].hiddenReason, 'no-seat');
  assert.equal(stats[2].shown, false);
});

test('CA4 widened capacity protects through idle expiry until real turn completion', () => {
  const windows = Array.from({ length: 65 }, (_, i) => ({ ...win(), id: i + 1 }));
  const rows = dump([world(windows), ...windows.map(w => aim([650, 800], { windowId: w.id })), clock(601),
    aim([650, 800]), { dumpStats: true },
    { hand: 'status', nonce, seq: ++seq, state: 'done', pid: 42, windowId: 7, at: [650, 800] }, { dumpStats: true }]);
  const stats = rows.filter(r => r.effect === 'stage-stats');
  assertWideSeat(stats[0]); assert.equal(stats[0].targetCapacity, false);
  assert.equal(stats[1].turnTargets, 0); assert.equal(stats[1].shown, true);
});

test('stage dump accepts the optional size setting and starts on medium A2 art without strips', () => {
  const rows = dump([world(), aim()], { art: false });
  assert.equal(latest(rows).height, 184);
  assert.equal(latest(rows).fallback, true);
  assert.equal(latest(rows).seat.kind, 'edge-lie');
  assert.equal(latest(rows).capture, 'none');
  assert.equal(latest(rows).hitAreas, 0);
  for (const size of ['small', 'medium', 'stage', 104, 560]) assert.ok(draws(dump([world(), aim()], { frame: character({ size }) })).length);
  for (const size of ['huge', true, 103, 561, null]) dump([], { frame: character({ size }), ok: 65 });
  for (const stageAttention of ['yes', 1, null]) dump([], { frame: character({ stageAttention }), ok: 65 });
});

test('clear full panels keep stage size beside narrow windows before the minimum window width refuses', () => {
  const values = [700, 500, 300, 150, 40].map(width => {
    const rows = dump([world([win([300, 400, width, 350])], { person: [300, 400, width, 350],
      cards: [[-200, 400, 500, 500], [300 + width, 400, 1800, 500]],
      displays: [{ frame: [0, 0, 1440, 900], visible: [0, 25, 1440, 800] }] }), aim([350, 700])], { frame: character({ perch: { anchor: [96, 208], table: Object.fromEntries(keys.map(k => [k, entry])) } }) });
    return latest(rows)?.rung ?? 'hidden';
  });
  assert.deepEqual(values, ['stage', 'stage', 'stage', 'stage', 'hidden']);
});

test('a held display slot caps another host at medium and yields stage again when free', () => {
  const rows = dump([world(), aim(), { dumpStageAvailable: false }, clock(1), { dumpStageAvailable: true }, clock(2)]);
  assert.deepEqual(draws(rows).map(r => r.rung), ['stage', 'medium', 'stage']);
  assert.deepEqual(draws(rows).map(r => r.height), [410.4, 184, 410.4]);
  for (const sessionBadge of ['A', 'Z']) dump([world(), aim()], { frame: character({ sessionBadge }) });
  for (const sessionBadge of ['AA', '', 1, null, '<']) dump([], { frame: character({ sessionBadge }), ok: 65 });
});

test('1,000 seeded placements have no target, ring, person, card or foreground-window violations', t => {
  let seed = 0x4a2137;
  const rand = (lo, hi) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return lo + seed / 2 ** 32 * (hi - lo); };
  const cases = Array.from({ length: 1000 }, (_, index) => {
    const w = win([rand(0, 900), rand(40, 650), rand(300, 1700), rand(200, 500)]);
    const at = [rand(w.frame[0], w.frame[0] + w.frame[2]), rand(w.frame[1], w.frame[1] + w.frame[3])];
    const rect = [at[0] - 12, at[1] - 8, rand(10, 180), rand(10, 90)];
    const person = [rand(0, 1600), rand(0, 1000), rand(100, 700), rand(100, 600)];
    const above = { id: 8, pid: 55, frame: [rand(0, 1500), rand(0, 700), rand(60, 450), rand(60, 400)] };
    const card = [rand(0, 1600), rand(0, 950), 180, 120], pointer = [rand(0, 1800), rand(0, 1200)];
    const a = aim(at, { rect });
    return { index, w, at, rect, person, above, card, pointer, a };
  });
  const rows = dump(cases.flatMap(c => [{ dumpReset: true }, world([c.above, c.w], { person: c.person, cards: [c.card], pointer: c.pointer }), c.a]));
  const bySeq = new Map(draws(rows).map(row => [row.seq, row]));
  let visible = 0;
  for (const c of cases) {
    const plan = bySeq.get(c.a.seq); if (!plan) continue; visible++;
    const box = plan.box;
    for (const forbidden of [expand([...c.at, 0, 0], 48), expand(c.rect, 48), c.person, c.card, c.above.frame]) assert.equal(overlaps(box, forbidden), false, `case ${c.index}`);
    assert.ok(box[0] >= 0 && box[1] >= 30 && box[0] + box[2] <= 1800 && box[1] + box[3] <= 1170, `display case ${c.index}`);
  }
  assert.ok(visible >= 100, `${visible} visible placements, must exercise more than hidden outputs`);
  assert.equal(rows.filter(r => r.effect === 'stage-hide').length + visible, 1000);
  t.diagnostic(`placements=1000 visible=${visible} hidden=${1000 - visible} violations=0`);
});

test('pointer entry dodges 120 points or hides immediately within 200 ms', () => {
  const frame = character({ stageAttention: false });
  const initial = latest(dump([world(), aim()], { frame })); const [x, y, w, h] = initial.box;
  const rows = dump([world(), aim(), clock(1), world([win()], { pointer: [x + w / 2, y + h / 2], inputAge: 0 })], { frame });
  const last = latest(rows);
  if (!rows.at(-1).shown) {
    const hide = rows.findLast(r => r.effect === 'stage-hide');
    assert.equal(hide.duration, 0); assert.equal(hide.time, 1);
  } else {
    assert.ok(last.dodgeMs <= 200);
    assert.ok(Math.abs(last.box[0] - x) >= 119);
  }
});

test('attention shrinks on input and grows at 8 seconds, with a reversible off setting', () => {
  const rows = dump([world([], {}), world(), aim(), clock(1), world([win()], { inputAge: 0 }), clock(9)]);
  assert.deepEqual(draws(rows).map(r => r.height), [410.4, 184, 410.4]);
  assert.equal(latest(dump([world([win()], { inputAge: 0 }), aim()], { frame: character({ stageAttention: false }) })).rung, 'stage');
});

test('CH-7 missing windows keep protected edge seats while full-screen windows hide', () => {
  for (const change of [world([]), world([win(undefined, { minimized: true })]),
    world([win(undefined, { onScreen: false })]), world([win([0, 0, 1800, 1200], { fullScreen: true })])]) {
    const rows = dump([world(), aim(), clock(1), change, { dumpStats: true }]);
    const hide = rows.filter(r => r.effect === 'stage-hide').at(-1);
    if (change.dumpWorld.windows.some(w => w.fullScreen)) assert.ok(hide && hide.duration <= 0.12, 'full-screen still hides');
    else assertWideSeat(rows.findLast(r => r.effect === 'stage-stats'), [win().frame]);
  }
  const restored = dump([world(), aim(), clock(1), world([win([210, 500, 900, 350])]), clock(1.49), clock(1.5), { dumpStats: true }]);
  assertWideSeat(restored.findLast(r => r.effect === 'stage-stats'), [win().frame, [210, 500, 900, 350]]);
});

test('lock, sleep and call remove every animation and suppress new aims until wake', () => {
  for (const flag of ['locked', 'sleeping', 'call']) {
    const rows = dump([world(), aim(), clock(0.1), { dumpActivity: { [flag]: true } }, aim(), clock(30)]);
    const end = rows.at(-1); assert.equal(end.shown, false); assert.equal(end.animations, 0);
    assert.equal(draws(rows).length, 1);
  }
});

test('front-sit is off by default and retreats when the person looks', () => {
  const tight = win([300, 30, 900, 1000]);
  const blocked = world([tight], { person: [1500, 100, 200, 600], cards: [[0, 30, 300, 1140], [1200, 30, 600, 1140]] });
  assert.notEqual(latest(dump([blocked, aim([350, 200])]))?.seat.kind, 'front-sit');
  const rows = dump([blocked, aim([350, 200]), clock(1), world([tight], { person: tight.frame })], { frame: character({ stageFrontSit: true }) });
  assert.equal(draws(rows)[0].seat.kind, 'front-sit');
  assert.notEqual(latest(rows)?.seat.kind, 'front-sit');
  if (rows.at(-1).shown) assert.equal(overlaps(latest(rows).box, tight.frame), false);
});

// FA1 (Fable 5.2, 2026-11-09): with no person window the attention is unknown, so it counts as looking.
test('FA1 case 2: a windowless front app never gets front-sit or edge-sit, even with front-sit allowed', () => {
  const tight = win([300, 30, 900, 1000]);
  const blocked = world([tight], { person: null, cards: [[0, 30, 300, 1140], [1200, 30, 600, 1140]] });
  const rows = dump([blocked, aim([350, 200]), clock(1), aim([400, 260]), clock(2)], { frame: character({ stageFrontSit: true }) });
  assert.ok(!draws(rows).some(d => ['front-sit', 'edge-sit'].includes(d.seat.kind)), JSON.stringify(draws(rows).map(d => d.seat.kind)));
});

test('FA1 cases 4 and 5: a person window that goes away or flickers never hides the character', () => {
  const far = [1500, 900, 200, 150];
  const rows = dump([world([win()], { person: far }), aim(), clock(1),
    ...Array.from({ length: 10 }, (_, i) => [world([win()], { person: i % 2 ? far : null }), clock(1.2 + i * 0.2)]).flat()]);
  assert.ok(draws(rows).length > 0);
  assert.ok(!rows.some(r => r.effect === 'stage-hide'), JSON.stringify(rows.filter(r => r.effect === 'stage-hide')));
});

test('FA1: a malformed missing flag in the dump world is refused', () => {
  for (const missing of [1, 'yes', null]) dump([world([win()], { missing })], { ok: 65 });
});

test('reduced motion uses first cells, no arcs, and at most two position values', () => {
  const rows = dump([world(), aim([650, 700]), clock(1), aim([1000, 700])], { reduced: true });
  for (const p of draws(rows)) { assert.ok(p.positions.length <= 2); assert.equal(new Set(p.cells.map(c => c[4])).size, 1); }
});

test('display moves pop, size changes crossfade and paused seats stay put', () => {
  const second = { frame: [1800, -300, 1600, 1400], visible: [1800, -270, 1600, 1320] };
  const rows = dump([world(), aim(), clock(1), world([win(), { id: 9, pid: 42, frame: [2000, 400, 900, 600] }], {
    displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }, second],
  }), aim([2500, 700], { windowId: 9 })]);
  const p = latest(rows); assert.equal(p.kind, 'far'); assert.equal(p.height, 475.2);
  assert.ok(p.positions.every(v => v[1] >= 1800));
  const paused = dump([world(), aim(), { dumpPaused: true }, clock(1), aim([1000, 700])]);
  assert.deepEqual(draws(paused)[0].box, latest(paused).box);
});

test('stage mode is dispatched before NSApplication startup and follows the hand capture setting', () => {
  const s = readFileSync(source, 'utf8');
  assert.ok(s.indexOf('if arguments.first == "--stage-dump"') < s.lastIndexOf('NSApplication.shared'));
  assert.match(s, /stagePanelSnapshot\(panel, capture: host\?\.capture \?\? "hidden"\)/);
});

test('all seat families can be selected with only the needed desktop spans free', () => {
  const cases = [
    { expected: 'edge-lie', w: win(), more: {} },
    { expected: 'edge-sit', w: win([200, 500, 650, 600]), more: {} },
    { expected: 'corner-hang', w: win([500, 30, 900, 1000]), more: { person: [1700, 1100, 80, 60] } },
    { expected: 'side-climb', w: win([500, 30, 900, 1000]), more: { person: [1700, 1100, 80, 60], cards: [[0, 30, 1800, 200]] } },
    { expected: 'desk-stand', w: win([500, 30, 900, 1000]), more: { person: [1700, 1100, 80, 60], cards: [[0, 30, 1800, 500]] } },
  ];
  for (const c of cases) {
    const p = latest(dump([world([c.w], c.more), aim([1000, 700])]));
    assert.equal(p?.seat.kind, c.expected, JSON.stringify(p));
  }
});

test('a leap crossing the person or the pointer becomes a far move, and safe paths stay clear between samples', () => {
  const a = win([200, 500, 700, 500]); const b = { id: 9, pid: 42, frame: [950, 500, 700, 500] };
  const person = [750, 100, 300, 300];
  const rows = dump([world([a, b], { person, pointer: [900, 200] }), aim([550, 800]), clock(1), aim([1300, 800], { windowId: 9 })]);
  const p = latest(rows); assert.equal(p.kind, 'far');
  for (const q of draws(rows)) for (const pos of q.positions) assert.equal(overlaps([pos[1], pos[2], q.box[2], q.box[3]], person), false);
});

test('pause removes motion immediately and lock during a move stays hidden after clocks and aims', () => {
  const rows = dump([world(), aim(), clock(0.02), { dumpPaused: true }]);
  assert.equal(rows.at(-1).animations, 0);
  const locked = dump([world(), aim(), clock(0.02), aim([1000, 700]), { dumpActivity: { locked: true } }, clock(100), aim()]);
  assert.equal(locked.at(-1).shown, false); assert.equal(locked.at(-1).animations, 0);
});

test('bad fixture geometry and duplicated identities fail closed before drawing', () => {
  for (const w of [world([win([0, 0, -1, 500])]), world([win(), win()]), world([win()], { person: [0, 0, 0, 10] }),
    world([win()], { pointer: [true, 10] }), world([win()], { displays: [] })]) dump([w, aim()], { ok: 65 });
});

test('numeric sizes and their fallbacks never grow above the requested height', () => {
  for (const size of [104, 150, 200, 560]) for (const art of [false, true]) {
    const p = latest(dump([world(), aim()], { frame: character({ size }), art }));
    assert.ok(p.height <= size, `${size}, art=${art}, height=${p.height}`);
  }
});

test('a newly raised window cancels an in-flight path even when the destination remains safe', () => {
  const rows = dump([climbWorld(), aim([800, 500]), clock(1), aim([800, 2000]), clock(1.05),
    climbWorld([{ id: 8, pid: 55, frame: [300, 1000, 200, 200] }])], { frame: standingCharacter() });
  const before = draws(rows).find(r => r.time === 1);
  assert.ok(before.positions.length > 2, 'fixture must start a real arc');
  const p = latest(rows); assert.equal(p.time, 1.05); assert.equal(p.positions.length, 1);
});

test('pointer dodge keeps the size and seat, with a 120 point move when there is space', () => {
  const start = latest(dump([world(), aim()], { frame: character({ size: 'medium' }) }));
  const pointer = [start.box[0] + 1, start.box[1] + 80];
  const p = latest(dump([world(), aim(), clock(1), world([win()], { pointer, inputAge: 0 })], { frame: character({ size: 'medium' }) }));
  assert.equal(p.box[0] - start.box[0], 120); assert.equal(p.height, 184); assert.equal(p.seat.kind, start.seat.kind);
  assert.equal(start.decisionReason, null);
  assert.equal(p.decisionReason, 'pointer-near');
});

test('paused motion freezes at its presentation position and resumes placement afterwards', () => {
  const rows = dump([climbWorld(), aim([800, 500]), clock(1), aim([800, 2000]),
    clock(1.3), { dumpPaused: true }, clock(2), { dumpPaused: false }], { frame: standingCharacter() });
  const pause = draws(rows).find(r => r.time === 1.3);
  assert.ok(pause.box[1] > 396 && pause.box[1] < 1896, 'paused halfway through the clear climb');
  assert.equal(pause.positions.length, 1); assert.equal(pause.cells.length, 1);
});

test('edge seats do not cover earlier targets from the same turn', () => {
  const first = [1000, 396];
  const rows = dump([world(), aim(first), clock(1), aim([300, 396])], { frame: character({ size: 'medium' }) });
  for (const p of draws(rows)) assert.equal(overlaps(p.box, expand([...first, 0, 0], 48)), false);
});

test('200 spread aims widen safely at record capacity without losing any target', t => {
  const w = win([100, 500, 1500, 800]);
  const targets = Array.from({ length: 200 }, (_, i) => {
    const at = [120 + i % 20 * 74, 560 + i % 20 * 18 + Math.floor(i / 20) * 35];
    return { at, rect: [at[0] - 12, at[1] - 8, 24, 16] };
  });
  const rows = dump([world([w], { person: [1700, 1100, 80, 60],
    displays: [{ frame: [0, 0, 1800, 1500], visible: [0, 30, 1800, 1440] }] }),
    ...targets.map(({ at, rect }) => aim(at, { rect })), { dumpStats: true }, { dumpMeasureTicks: 500 }]);
  const sample = rows.find(r => r.effect === 'stage-stats');
  assert.equal(sample.targetCapacity, false); assertWideSeat(sample, [w.frame]);
  assert.ok(sample.wideWindows.length > 0);
  for (const target of targets) for (const r of [expand([...target.at, 0, 0], 48), expand(target.rect, 48)]) {
    assert.ok(sample.forbidden.some(f => f[0] <= r[0] && f[1] <= r[1] && f[0] + f[2] >= r[0] + r[2] && f[1] + f[3] >= r[1] + r[3]), 'every old box remains covered');
  }
  const cost = rows.find(r => r.effect === 'stage-cost');
  assert.ok(cost.turnTargets <= 64); assert.ok(cost.msPerTick < 2);
  t.diagnostic(JSON.stringify({ aims: 200, wideWindows: sample.wideWindows.length, ...cost }));
});

test('seated art keeps corner-hang when the person occupies the target window', () => {
  for (const size of ['stage', 'medium', 'small']) {
    const w = win();
    const p = latest(dump([world([w], { person: w.frame }), aim()], { frame: character({ size }) }));
    assert.equal(p?.seat.kind, 'corner-hang');
    assert.equal(overlaps(p.box, w.frame), false);
  }
});

test('edge-sit prefers the left end of the first safe span for one-way seated art', () => {
  const w = win([200, 500, 650, 600]);
  const p = latest(dump([world([w]), aim([750, 900])]));
  assert.equal(p.seat.kind, 'edge-sit');
  assert.equal(p.box[0], 281.01);
  const blocked = latest(dump([world([w], { cards: [[280, 30, 40, 600]] }), aim([750, 900])]));
  assert.equal(blocked.seat.kind, 'edge-sit');
  assert.ok(Math.abs(blocked.box[0] - 321.01) < 0.001);
});

test('pointer fallback hides immediately when a full 120 point dodge cannot fit', () => {
  const window = win([200, 500, 300, 350]);
  const initial = latest(dump([world([window]), aim([350, 700])], { frame: character({ size: 'medium' }) }));
  const pointer = [initial.box[0] + 80, initial.box[1] + 80];
  const rows = dump([world([window]), aim([350, 700]), clock(1), world([window], { pointer, inputAge: 0 })], { frame: character({ size: 'medium' }) });
  assert.equal(rows.at(-1).shown, false); assert.equal(rows.findLast(r => r.effect === 'stage-hide').duration, 0);
  assert.equal(rows.at(-1).hiddenReason, 'pointer-covered');
});

test('safe climbs use A2 running cells and stop moving by 600 milliseconds', () => {
  const rows = dump(stageTraceLines([climbWorld(), aim([800, 500]), clock(1), aim([800, 2000])]), { frame: standingCharacter() });
  const p = latest(rows); assert.equal(p.kind, 'run'); assert.ok(p.states.includes('running-right'));
  assert.ok(p.positions.at(-1)[0] <= 0.6);
  const audit = auditStageTrace(collectStageTrace(rows));
  assert.deepEqual(audit.errors, []);
  assert.ok(audit.segments > 0 && audit.pairs > 0, 'audit actual moving panels as well as popped transfers');
});

test('A2 sleep starts after 20 seconds idle, parks, and hides after ten minutes', () => {
  const rows = dump([world(), aim(), clock(19.99), clock(20), clock(40), clock(600)], { art: false });
  assert.ok(draws(rows).find(r => r.time === 20)?.states.includes('sleep'));
  assert.equal(rows.at(-1).shown, false); assert.equal(rows.at(-1).animations, 0);
});

test('motion panel bounds enclose a clear full path with only whole-point rounding', () => {
  const p = latest(dump([climbWorld(), aim([800, 500]), clock(1), aim([800, 2000])], { frame: standingCharacter() }));
  assert.ok(p.positions.length > 2);
  const left = Math.floor(Math.min(...p.positions.map(([, x]) => x)));
  const top = Math.floor(Math.min(...p.positions.map(([, , y]) => y)));
  const right = Math.ceil(Math.max(...p.positions.map(([, x]) => x + p.metricSize[0])));
  const bottom = Math.ceil(Math.max(...p.positions.map(([, , y]) => y + p.metricSize[1])));
  assert.deepEqual(p.panel, [left, top, right - left, bottom - top]);
  for (const [, x, y] of p.positions) {
    assert.ok(x >= p.panel[0] && y >= p.panel[1]);
    assert.ok(x + p.metricSize[0] <= p.panel[0] + p.panel[2] + 1e-6 && y + p.metricSize[1] <= p.panel[1] + p.panel[3] + 1e-6);
  }
});

test('a narrow window can use a full stage corner when desktop space is free', () => {
  const p = latest(dump([world([win([700, 30, 300, 1000])], { person: [1700, 1100, 80, 60] }), aim([850, 700])]));
  assert.equal(p.height, 410.4); assert.equal(p.seat.kind, 'corner-hang');
});

test('A2 cheers once at a successful turn end', () => {
  const status = (state, more = {}) => ({ hand: 'status', nonce, seq: ++seq, state, pid: 42, windowId: 7, at: [650, 700], ...more });
  const rows = dump([world(), aim(), status('done', { ok: true }), status('done'), status('done')], { art: false });
  assert.equal(draws(rows).filter(r => r.states.includes('high-five')).length, 1);
});

test('A2 startles on the first frame after sleep', () => {
  const wake = dump([world(), aim(), clock(20), clock(20.1), aim()], { art: false });
  assert.ok(latest(wake).states.includes('startle'));
});


test('A2 edge seats put the 150 pixel seat line on the window edge at both sizes', () => {
  for (const size of ['medium', 'small']) {
    const p = latest(dump([world(), aim()], { frame: character({ size }), art: false }));
    assert.ok(['edge-lie', 'edge-sit'].includes(p.seat.kind));
    assert.equal(p.box[1] + 150 * p.height / 184, 500);
    assert.equal(p.box[1] + p.box[3] - 500, 58 * p.height / 184);
  }
});

test('polling slows asleep and hidden, stops locked and display asleep, then resumes on notification', () => {
  const stats = lines => dump(lines, { art: false }).filter(r => r.effect === 'stage-stats');
  const rows = stats([world(), aim(), { dumpStats: true }, clock(20), { dumpStats: true },
    { dumpActivity: { locked: true } }, { dumpStats: true }, { dumpActivity: { locked: false } }, { dumpStats: true },
    { dumpActivity: { sleeping: true } }, { dumpStats: true }, { dumpActivity: { sleeping: false } }, { dumpStats: true },
    world([]), { dumpStats: true }]);
  assert.deepEqual(rows.map(r => r.poll), [0.2, 2, null, 2, null, 2, 2]);
});

test('pointer callback fixture measures an injected run-loop delay after 200 seconds idle', t => {
  const frame = character({ size: 'medium', stageAttention: false });
  const start = latest(dump([world(), aim(), clock(200)], { frame, art: false }));
  const pointer = [start.box[0] + 1, start.box[1] + 80];
  const run = delayMs => latest(dump([world(), aim(), clock(200), { dumpPointer: { at: pointer, delayMs } }], { frame, art: false }));
  const p = run(37);
  assert.ok(Math.abs(p.box[0] - start.box[0]) >= 119 || p.opacity.at(-1)[1] === 0.35);
  assert.ok(p.dodgeMs >= 35 && p.dodgeMs < 200);
  assert.ok(p.dodgeMs <= 200);
  assert.ok(run(250).dodgeMs > 200, 'a delayed callback must fail the latency limit');
  t.diagnostic(`fixture callback delay ${p.dodgeMs.toFixed(3)} ms after 200 s idle, excludes host event and install latency`);
});

test('placement tick cost stays bounded after 25, 100 and 200 aims', t => {
  for (const layout of ['overlapping', 'separate']) {
    const measured = [];
    for (const count of [25, 100, 200]) {
      const lines = [world()];
      for (let i = 0; i < count; i++) lines.push(aim(layout === 'overlapping' ?
        [210 + i % 18 * 48, 500 + Math.floor(i / 18) * 35] : [210 + i % 20 * 110, 1100 + Math.floor(i / 20) * 110]));
      const rows = dump([...lines, { dumpMeasureTicks: 500 }]);
      const cost = rows.find(r => r.effect === 'stage-cost');
      assert.ok(cost.turnTargets <= 64);
      assert.ok(cost.forbiddenBuilds <= 500, 'at most one forbidden set per tick');
      assert.ok(cost.msPerTick < 2, `${count} aims: ${cost.msPerTick} ms per tick`);
      measured.push({ aims: count, ...cost });
    }
    assert.ok(Math.max(...measured.map(r => r.msPerTick)) < Math.min(...measured.map(r => r.msPerTick)) * 4 + 0.05);
    t.diagnostic(JSON.stringify({ layout, measured }));
  }
});

test('a windowless front app still seats the character in the dump as in the host', () => {
  const rows = dump([world([win()], { person: null }), aim()]);
  assert.ok(draws(rows).length > 0, 'no person window must not hide the character (2026-11-09)');
  assert.ok(!rows.some(r => r.hiddenReason === 'gone'));
});

test('stage reinstall uses shared capture and hit policy without ordering an unchanged panel', () => {
  const s = readFileSync(source, 'utf8');
  const install = s.slice(s.indexOf('    func install(_ plan: PerchPlan'), s.indexOf('    // Three z glyphs'));
  assert.match(install, /if panel.isVisible && panel.frame != appKitRect\(target\) \{ panel.orderOut\(nil\) \}/);
  assert.ok(install.indexOf('panel.orderOut(nil)') < install.indexOf('root?.removeFromSuperlayer()'));
  assert.ok(install.indexOf('root?.removeFromSuperlayer()') < install.indexOf('panel.setFrame('));
  assert.equal((install.match(/orderOut/g) ?? []).length, 1);
  assert.match(install, /if !panel.isVisible \{ panel.orderFrontRegardless\(\) \}/);
  assert.match(install, /stagePanelSnapshot\(panel, capture: host\?\.capture \?\? "hidden"\)/);
  assert.match(s, /NSEvent.addGlobalMonitorForEvents\(matching: mouse/);
  assert.match(s, /character hidden: /);
  assert.match(s, /if !actual.stageSafe\(for: host\?\.capture \?\? "hidden"\) \{ spriteWarning\("stage panel policy mismatch/);
  // A capture-mode change reaches the character panel at once, not at its next install.
  assert.match(s, /self\.perch\.panel\?\.sharingType = handCaptureModes\[capture\] \?\? NSWindow\.SharingType\.none/);
});

test('mouse metadata reads stop for hidden, asleep and paused characters', () => {
  const rows = dump([world(), aim(), { dumpStats: true }, { dumpPaused: true }, { dumpStats: true },
    { dumpPaused: false }, clock(20), { dumpStats: true }, world([]), { dumpStats: true }]);
  assert.deepEqual(rows.filter(r => r.effect === 'stage-stats').map(r => r.pointerActive), [true, false, false, false]);
  const s = readFileSync(source, 'utf8');
  const mouse = s.slice(s.indexOf('    func stagePointerChanged('), s.indexOf('    func stageEnvironment('));
  assert.match(mouse, /guard stageActive, stage.pointerActive/);
  assert.match(mouse, /guard self.stageActive, self.stage.pointerActive/);
});

test('reviewer stateful fuzz has zero violations across five display topologies', { timeout: 60000 }, t => {
  const result = runStageFuzz(host(), { seed0: 1, cases: 100, maxSteps: 14, stepBudget: 3000 });
  assert.deepEqual(result.violations, {}, JSON.stringify(result.samples));
  assert.ok(result.ms < 60000);
  assert.equal(result.stats.cases, 100);
  assert.deepEqual(Object.keys(result.stats.adversarial).sort(), ['Space away/back', 'minimize/restore', 'move away/back', 'window ID reused by different PID'].sort());
  assert.ok(result.stats.multi > 0 && result.stats.negative > 0 && result.stats.tiny > 0 && result.stats.moves > 0 && result.stats.locks > 0 && result.stats.ptr > 0 && result.stats.draws > 0);
  assert.ok(result.stats.noPerson > 0, "FA1: draws with no person window exist and pass the oracle");
  t.diagnostic(JSON.stringify(result));
});

test('the stateful oracle detects a deliberately wrong aim radius', { timeout: 60000 }, t => {
  const result = runStageFuzz(host(), { seed0: 1, cases: 100, maxSteps: 14, stepBudget: 3000, aimRadius: 60 });
  assert.ok(Object.keys(result.violations).some(k => k.includes('target/ring')), JSON.stringify(result));
  t.diagnostic(JSON.stringify({ ms: result.ms, violations: result.violations }));
});

test('the stateful oracle accepts seats frozen by pause at the review seeds', { timeout: 60000 }, t => {
  for (const seed0 of [1100, 5000]) {
    const result = runStageFuzz(host(), { seed0, cases: 20, maxSteps: 14, stepBudget: 600 });
    assert.deepEqual(result.violations, {}, JSON.stringify(result.samples));
    t.diagnostic(JSON.stringify({ seed0, steps: result.stats.steps, draws: result.stats.draws, violations: result.violations }));
  }
});


test('panel diagnostics read installed flags and detect a panel that keeps capture or mouse input', () => {
  const s = readFileSync(source, 'utf8');
  const start = s.indexOf('protocol HandPanelSurface:'), end = s.indexOf('func makeHandPanel(capture:', start);
  const text = `import AppKit\n${s.slice(start, end)}
let panel = StagePanelProbe()
let initial = HandPanelPolicy(panel)
precondition(initial.captureName == "readOnly" && initial.hitAreas == 1)
let actual = stagePanelSnapshot(panel)
precondition(actual.captureName == "none" && actual.hitAreas == 0)
precondition(actual.stageSafe)
panel.sharingType = .readOnly; panel.ignoresMouseEvents = false
let changed = HandPanelPolicy(panel)
precondition(changed.captureName == "readOnly" && changed.hitAreas == 1)
precondition(!changed.stageSafe)
panel.sharingType = .none
precondition(!HandPanelPolicy(panel).stageSafe)
panel.ignoresMouseEvents = true
precondition(HandPanelPolicy(panel).stageSafe)
// The hand capture setting: visible lets recordings show stage panels; hidden (the default) keeps them out.
let visible = stagePanelSnapshot(panel, capture: "visible")
precondition(visible.captureName == "readOnly" && visible.hitAreas == 0)
precondition(visible.stageSafe(for: "visible") && !visible.stageSafe(for: "hidden") && !visible.stageSafe)
let hidden = stagePanelSnapshot(panel, capture: "hidden")
precondition(hidden.captureName == "none" && hidden.stageSafe(for: "hidden") && !hidden.stageSafe(for: "visible"))
precondition(stagePanelSnapshot(panel, capture: "bogus").captureName == "none")
panel.ignoresMouseEvents = false
precondition(!HandPanelPolicy(panel).stageSafe(for: "visible"))
`;
  const file = join(folder, 'panel-policy.swift'), output = join(folder, 'panel-policy');
  writeFileSync(file, text);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', output], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
});


test('stage call monitor explains failed queries while retaining the latest successful reading without reading real audio', () => {
  const s = readFileSync(source, 'utf8');
  const start = s.indexOf('final class StageCallMonitor {'), end = s.indexOf('// END STAGE', start);
  const text = `import Foundation
import CoreAudio
import QuartzCore
var reasons: [String] = [], probes = 0, offMain = false
func spriteWarning(_ reason: String) { reasons.append(reason) }
struct FakeAudio {
    func processes() -> [UInt32]? { probes += 1; offMain = !Thread.isMainThread; return nil }
    func word(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32) -> UInt32? { 0 }
}
enum NarrationAudio { static let system = FakeAudio() }
struct StageCallWorker {
    let subscribed = false
    func refreshSubscription() {}
    func query(executable: String?, arguments: [String], deadline: Double?, requestByte: UInt8) -> (quiet: Bool, state: String, reason: String) {
        precondition(deadline == 1 && requestByte == 3)
        _ = NarrationAudio.system.processes()
        return (false, "unavailable", "microphone process metadata unavailable")
    }
    func stop() {}
}
let stageCallWorker = StageCallWorker()
${s.slice(start, end)}
let monitor = StageCallMonitor()
var changed = 0
monitor.changed = { changed += 1 }
let began = CACurrentMediaTime()
precondition(!monitor.active(began))
precondition(!monitor.active(began + 0.1))
while monitor.pending && CACurrentMediaTime() - began < 2 { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.005)) }
precondition(!monitor.pending && probes == 1 && offMain && changed == 1)
let now = CACurrentMediaTime()
monitor.requested = now + 100
precondition(!monitor.active(now)); precondition(reasons.isEmpty)
monitor.complete((false, "input-active", "microphone input active"), at: now, elapsedMs: 0)
precondition(monitor.active(now)); precondition(monitor.active(now + 4))
monitor.complete((false, "unavailable", "unavailable"), at: now + 5, elapsedMs: 0)
precondition(monitor.active(now + 6))
precondition(reasons.count == 1 && reasons[0].contains("microphone input active"))
monitor.complete((true, "quiet", "quiet"), at: now + 7, elapsedMs: 0)
precondition(!monitor.active(now + 8)); precondition(!monitor.active(now + 50))
`;

  const file = join(folder, 'stage-call.swift'), output = join(folder, 'stage-call');
  writeFileSync(file, text);
  const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', output], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(compile, 0, compile.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(run, 0, run.stderr);
});

});
