import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';
import { runStageObligationFuzz, auditStageObligations } from './fixtures/stage-stateful-fuzz.mjs';
import { collectStageTrace } from './fixtures/stage-trace-chunks.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-area-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const source = process.env.CA1_BASELINE_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
let binary;
function host() {
  if (binary) return binary;
  let text = readFileSync(source, 'utf8');
  const variants = {
    'missing-wide-frame': s => s.replace('out += wideFrames(world)', '// missing wide frames'),
    'wide-forgets-old-boxes': s => s.replace('world.base.above + world.cards + activeTargets', 'world.base.above + world.cards + (wideWindows.isEmpty ? activeTargets : [])'),
    'stale-hides-nothing': s => s.replaceAll('retainWide(key, box: measured.union(observed).insetBy(dx: -48, dy: -48))', '// stale frame ignored'),
    'drag-destination-ignored': s => s.replace('if let destination = world.orderedWindows.first', 'if false, let destination = world.orderedWindows.first'),
    'capacity-drops-oldest': s => s.replace('if !box.isNull { retainWide(key, box: box) }', 'wideRecords[key] = windowBook.current[key]!.bounds.insetBy(dx: -48, dy: -48)'),
    'panel-padding': s => s.replace('return extent.integral.intersection(plan.seat.usable ?? plan.seat.display)', 'return extent.integral.insetBy(dx: -24, dy: -24).intersection(plan.seat.display)'),
    'area-window-ignored': s => s.replace('if let area = ev.area, !turnEnd {', 'if false, let area = ev.area, !turnEnd {'),
    'area-app-forgets-new': s => s.replaceAll('where wideApps.contains(key.pid)', 'where false && wideApps.contains(key.pid)'),
  };
  if (process.env.CA1_BROKEN_VARIANT) {
    const changed = variants[process.env.CA1_BROKEN_VARIANT]?.(text);
    assert.ok(changed && changed !== text, 'production area mutation site'); text = changed;
  }
  const file = join(root, 'host.swift'); writeFileSync(file, text);
  binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); return binary;
}
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const frame = { hand: 'character', nonce, seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null, cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 208], table: Object.fromEntries(states.map(s => [s, entry])) }, size: 'medium' };
const a = { id: 7, pid: 42, frame: [100, 600, 500, 250] }, b = { id: 9, pid: 43, frame: [900, 600, 500, 250] };
const world = (windows = [a, b]) => ({ dumpWorld: { windows, displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
  person: [1650, 1050, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10, cards: [] } });
const aim = (seq, w = a, extra = {}) => ({ hand: 'aim', nonce, seq, kind: 'click', pid: w.pid, windowId: w.id, at: [w.frame[0] + 250, w.frame[1] + 200], ...extra });
const act = (seq, kind, w = a, extra = {}) => ({ hand: 'act', nonce, seq, kind, pid: w.pid, windowId: w.id,
  at: [w.frame[0] + 250, w.frame[1] + 200], path: [[w.frame[0] + 250, w.frame[1] + 200]], beats: 1, delayMs: 0, ...extra });
const stats = { dumpStats: true }, clock = dumpClock => ({ dumpClock });
function dump(lines) {
  const result = spawnSync(host(), ['--stage-dump'], { input: [frame, { dumpStageArt: true }, world(), ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  assertChildStatus(result, 0, result.stderr || result.stdout.slice(-2000));
  return result.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'stage-stats');
}
const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
const overlap = (a, b) => a[0] < b[0] + b[2] - 1e-7 && b[0] < a[0] + a[2] - 1e-7 && a[1] < b[1] + b[3] - 1e-7 && b[1] < a[1] + a[3] - 1e-7;
const contains = (r, s) => r[0] <= s[0] + 1e-6 && r[1] <= s[1] + 1e-6 && r[0] + r[2] >= s[0] + s[2] - 1e-6 && r[1] + r[3] >= s[1] + s[3] - 1e-6;
function covered(row, rect, message) {
  assert.ok(row.forbidden?.some(r => contains(r, rect)), `${message}: uncovered ${rect}`);
}

describe('CA1 area protection', { skip: macCommandSkip('xcrun'), timeout: 900000 }, () => {

  test('CA7 the real ring preserves a drag grab point after another target was shown', () => {
    const result = spawnSync(host(), ['--stage-dump', '--through-ring'], { input: [frame, { dumpStageArt: true }, world(),
      { dumpTrace: true }, aim(2, a, { at: [500, 650] }), act(3, 'drag', a, { at: [350, 800], path: [[350, 800], [1100, 800]] }),
      clock(1), { dumpTraceRead: true },
    ].map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const trace = collectStageTrace(result.stdout.trim().split('\n').map(JSON.parse));
    const event = trace.records.find(r => r.input.op === 'receive' && r.input.event?.state === 'drag')?.input.event;
    assert.deepEqual(event?.at, [1100, 800]);
    assert.deepEqual(event?.end, [350, 800], 'animation entrance points are not the real grab point');
  });

  test('CA7 app-wide metadata includes its elevated windows without changing other apps or drop order', () => {
    const metadata = (pid, id, layer) => ({ kCGWindowOwnerPID: pid, kCGWindowNumber: id, kCGWindowLayer: layer,
      kCGWindowBounds: { X: 100, Y: 600, Width: 500, Height: 250 } });
    const result = spawnSync(host(), ['--stage-dump'], { input: [frame,
      { dumpWindowMetadata: { windows: [metadata(42, 7, 0), metadata(42, 8, 101), metadata(43, 9, 101), metadata(43, 10, 0)], appPids: [42] } },
    ].map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const row = result.stdout.trim().split('\n').map(JSON.parse).find(r => r.effect === 'stage-census');
    assert.deepEqual(row.windows.map(w => w.id), [7, 8, 10]);
    assert.deepEqual(row.dropWindows.map(w => w.id), [7, 10]);
  });

  test('CA7 an app with only an elevated window retains a real metadata anchor', () => {
    const metadata = { kCGWindowOwnerPID: 42, kCGWindowNumber: 8, kCGWindowLayer: 101,
      kCGWindowBounds: { X: 100, Y: 600, Width: 500, Height: 250 } };
    const result = spawnSync(host(), ['--stage-dump'], { input: [frame,
      { dumpWindowMetadata: { windows: [metadata], appPids: [42] } },
    ].map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const row = result.stdout.trim().split('\n').map(JSON.parse).find(r => r.effect === 'stage-census');
    assert.deepEqual(row.areaAnchors, [{ pid: 42, id: 8, area: 'app', at: [350, 725] }]);
    assert.deepEqual(row.dropWindows, [], 'the input destination census still excludes elevated windows');
  });

  test('CA7 a terminal publishes released protection before moving a previously safe panel', () => {
    const scene = { dumpWorld: { windows: [{ id: 7, pid: 42, frame: [4, 37, 1318, 905] }],
      displays: [{ frame: [0, 0, 1512, 982], visible: [0, 33, 1512, 949] }],
      person: [700, 450, 126, 126], pointer: [1500, 970], inputAge: 20, pointerAway: 10, cards: [] } };
    const area = { hand: 'status', nonce, seq: 2, pid: 42, windowId: 7, area: 'window', state: 'thinking' };
    const rows = dump([scene, area, stats, { ...area, seq: 3, state: 'handback' }, stats, clock(0.21), stats]);
    assert.ok(rows[0].presented);
    assert.equal(rows[1].wideWindows.length, 0, 'the terminal releases its obligations immediately');
    assert.deepEqual(rows[1].presented.panel, rows[0].presented.panel, 'keep the safe panel through one observation interval');
    assert.notDeepEqual(rows[2].presented.panel, rows[0].presented.panel, 'the terminal reaction can then re-seat');
  });

  test('CA7 a moved uncertain window widens and immediately finds a clear seat', () => {
    const moved = { ...a, frame: [150, 550, 500, 250] };
    const row = dump([aim(2), act(3, 'scroll'), world([moved, b]), stats])[0];
    covered(row, expand(a.frame), 'the old wide frame remains');
    covered(row, expand(moved.frame), 'the new wide frame bounds the target');
    assert.equal(row.shown, true, 'known uncertainty must try clear seats before hiding');
  });

  test('CA7 the obligation oracle rejects a missing panel and a clear art box with an unsafe panel', () => {
    const row = { time: 0, planBegan: 0, presented: { box: [0, 30, 100, 100], seat: { window: 7 }, positions: [[0, 0, 30]], opacity: [[0, 1]] } };
    const scene = world().dumpWorld;
    assert.ok(auditStageObligations([], row, scene).errors.includes('missing panel rectangle'));
    row.presented.panel = [1600, 1000, 180, 180];
    assert.ok(auditStageObligations([], row, scene).errors.some(e => e.startsWith('protected intersection')));
    row.presented.panel = row.presented.box;
    assert.deepEqual(auditStageObligations([], row, scene).errors, []);
  });

  test('CA7 the whole panel rectangle clears every protected area', () => {
    const rows = dump([aim(2), act(3, 'scroll'), stats, aim(4, b), stats]);
    for (const row of rows.filter(r => r.presented)) {
      assert.ok(row.presented.panel.every(Number.isInteger), 'the real panel must use whole-point geometry');
      assert.ok(row.presented.panel[3] < row.presented.box[3] + 2, 'outward panel rounding adds less than two points');
      assert.ok(row.forbidden.every(r => !overlap(row.presented.panel, r)),
        'the panel, including transparent padding, cannot intersect protection');
    }
  });

  test('CA7 panel boundaries leave a gap at the menu bar and every protected rectangle', () => {
    const menu = { id: 30, pid: 55, frame: [0, 0, 1800, 30] };
    const row = dump([world([menu, a, b]), { hand: 'status', nonce, seq: 2, state: 'thinking', area: 'app', pid: a.pid, windowId: 0 }, stats]).at(-1);
    assert.equal(row.shown, true);
    const p = row.presented.panel;
    const touches = (a, b) => a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];
    assert.ok(row.forbidden.every(r => !touches(p, r)), 'the independent sampler counts touching boundaries');
  });

  test('CA7 an unlocated action widens its window and preserves a visible seat', () => {
    const row = dump([{ hand: 'status', nonce, seq: 2, state: 'thinking', area: 'window', pid: a.pid, windowId: a.id }, stats]).at(-1);
    assert.equal(row.shown, true);
    assert.ok(row.wideWindows.some(w => w.pid === a.pid && w.id === a.id));
    assert.ok(row.forbidden.some(r => contains(r, expand(a.frame, 48))));
  });

  test('CA7 app-only protection includes every app window and windows appearing later in the turn', () => {
    const sibling = { ...b, pid: a.pid };
    const later = { id: 11, pid: a.pid, frame: [200, 300, 400, 200] };
    const rows = dump([world([a, sibling]), { hand: 'status', nonce, seq: 2, state: 'thinking', area: 'app', pid: a.pid, windowId: 0 }, stats,
      world([a, sibling, later]), clock(1), stats]);
    assert.equal(rows[0].wideWindows.length, 2);
    assert.equal(rows[1].wideWindows.length, 3);
    assert.ok(rows[1].forbidden.some(r => contains(r, expand(later.frame, 48))));
    assert.equal(rows[1].shown, true);
  });
  test('scroll widens only with prior obligations and leaves another window visible', () => {
    const first = dump([act(2, 'scroll'), stats])[0];
    assert.equal(first.wideWindows?.length ?? 0, 0, 'first scroll has no prior obligation');
    const rows = dump([aim(2), act(3, 'scroll'), stats, aim(4, b), stats]);
    covered(rows[0], expand(a.frame), 'wide frame');
    assert.equal(rows[1].shown, true, 'a different window remains visible after scroll');
    assert.equal(rows[0].hideReasonCounts['target-unmapped'] ?? 0, 0);
  });

  test('wide windows retain old boxes across moves, gaps, PID reuse and two wide windows', () => {
    const old = [-200, 360, 30, 20], moved = { ...a, frame: [100, 800, 500, 250] };
    const reused = { ...a, pid: 99 };
    const rows = dump([aim(2, a, { rect: old }), act(3, 'scroll'), world([moved, b]), clock(1), aim(4, b), stats,
      world([b]), stats, world([a, b]), stats, world([reused, b]), aim(5, reused), stats,
      act(6, 'scroll', b), stats]);
    for (const row of rows) covered(row, expand(old), 'retained old box');
    covered(rows[0], expand(moved.frame), 'current moved wide frame');
    covered(rows[1], expand(moved.frame), 'wide frame survives a visibility gap');
    covered(rows[2], expand(a.frame), 'returned wide frame');
    covered(rows[3], expand(reused.frame), 'PID reuse at equal bounds');
    covered(rows[4], expand(b.frame), 'second wide frame');
  });

  test('wide frame refresh follows every poll even while another window acts', () => {
    const lines = [aim(2), act(3, 'scroll'), aim(4, b)];
    for (let i = 0; i < 5; i++) lines.push(world([{ ...a, frame: [100 + i * 17, 600 - i * 13, 500, 250] }, b]), stats);
    const rows = dump(lines);
    rows.forEach((r, i) => covered(r, expand([100 + i * 17, 600 - i * 13, 500, 250]), 'poll frame'));
  });

  test('stale geometry keeps measured and observed frames through later matching frames', () => {
    for (const measured of [[99.5, 600, 500, 250], [400, 600, 500, 250], [100, 600, 700, 400]]) {
      const rows = dump([aim(2, a, { windowRect: measured }), stats, aim(3, b), stats, aim(4, a, { windowRect: a.frame }), stats]);
      for (const r of rows) { covered(r, expand(measured), 'stale measured frame'); covered(r, expand(a.frame), 'stale observed frame'); }
      assert.equal(rows[0].hideReasonCounts['stale-window'], 0);
      assert.ok(rows[0].maxWindowBoundsDifferencePt >= 0.5);
    }
  });

  test('paused stale admission retains its measured frame after another window acts', () => {
    const measured = [100, 600, 700, 400];
    const row = dump([aim(2, b), { dumpPaused: true }, aim(3, a, { windowRect: measured }), aim(4, b), { dumpPaused: false }, stats])[0];
    covered(row, expand(measured), 'paused stale measured frame');
    covered(row, expand(a.frame), 'paused stale observed frame');
    assert.equal(row.maxWindowBoundsDifferencePt, 200);
  });

  test('drag destination widens the frontmost containing window and leaves desktop drops alone', () => {
    const front = { id: 11, pid: 55, frame: [920, 600, 500, 250] };
    for (const [windows, end, expected] of [[[a, b], [1100, 800], b], [[front, a, b], [1100, 800], front],
      [[a, b], [350, 800], a], [[a, b], [1600, 950], null]]) {
      const row = dump([world(windows), act(2, 'drag', a, { at: end, path: [[350, 800], end] }), aim(3, a), stats])[0];
      covered(row, expand(a.frame), 'drag source');
      if (expected) covered(row, expand(expected.frame), 'drag destination');
      assert.equal(row.wideWindows.length, expected && expected.id !== a.id ? 2 : 1);
    }
  });

  test('capacity widening retains outlying obligations and permits another window to draw', () => {
    const lines = [aim(2, a, { at: [-200, 360] })];
    for (let i = 0; i < 513; i++) lines.push(aim(i + 3, a));
    const row = dump([...lines, aim(516, b), stats])[0];
    assert.equal(row.targetCapacity, false, 'contributors widen instead of hiding');
    assert.ok(row.contributors <= 512 && row.turnTargets <= 64);
    covered(row, expand([-200, 360, 0, 0]), 'capacity keeps oldest box');
    covered(row, expand(a.frame), 'capacity frame');
    assert.equal(row.shown, true, 'capacity widening leaves a visible seat');
  });

  test('capacity handles 65 records and 65 windows with bounded wide aggregates', () => {
    const points = Array.from({ length: 65 }, (_, i) => aim(i + 2, a, { at: [-300 + i * 100, 300] }));
    const one = dump([...points, aim(67, b), stats])[0];
    assert.equal(one.targetCapacity, false); assert.ok(one.turnTargets <= 64);
    for (const p of points) covered(one, expand([...p.at, 0, 0]), 'record capacity');
    const windows = Array.from({ length: 65 }, (_, i) => ({ ...a, id: i + 1 }));
    const many = dump([world(windows), ...windows.map((w, i) => aim(i + 2, w)), stats])[0];
    assert.equal(many.targetCapacity, false); assert.ok(many.turnTargets <= 64 && many.wideRecords.length <= 128);
  });

  test('wide record storage stays bounded when a 129th identity arrives stale', () => {
    const windows = Array.from({ length: 128 }, (_, i) => ({ id: i + 1, pid: 42, frame: [100 + i * 600, 600, 500, 250] }));
    const scene = ws => {
      const line = world(ws);
      Object.assign(line.dumpWorld, { displays: [{ frame: [0, 0, 90000, 1200], visible: [0, 30, 90000, 1140] }],
        person: [89800, 1000, 100, 100], pointer: [89990, 1190] });
      return line;
    };
    const lines = [scene(windows)];
    for (let i = 0; i < 128; i += 2) {
      const start = [windows[i].frame[0] + 250, 800], end = [windows[i + 1].frame[0] + 250, 800];
      lines.push(act(i / 2 + 2, 'drag', windows[i], { at: end, path: [start, end] }));
    }
    const moved = windows.map(w => ({ ...w, frame: [w.frame[0] + 1, ...w.frame.slice(1)] }));
    const replacement = { ...moved.at(-1), id: 129 };
    const row = dump([...lines, scene(moved), stats, scene([...moved.slice(0, -1), replacement]),
      aim(66, replacement, { windowRect: [replacement.frame[0] - 300, 600, 500, 250] }), stats]).at(-1);
    assert.equal(row.targetCapacity, true); assert.equal(row.shown, false);
    assert.ok(row.wideWindows.length <= 128 && row.wideRecords.length <= 128, 'wide storage cannot exceed 128 identities');
  });

  test('wide obligations release only at the terminal frame', () => {
    const rows = dump([aim(2), act(3, 'scroll'), { hand: 'status', nonce, seq: 4, pid: a.pid, windowId: a.id, at: [350, 800], state: 'done', ok: true },
      clock(200), stats, { hand: 'status', nonce, seq: 5, pid: a.pid, windowId: a.id, at: [350, 800], state: 'handback' }, stats]);
    assert.equal(rows[0].wideWindows.length, 1); assert.equal(rows[1].wideWindows.length, 0); assert.equal(rows[1].wideRecords.length, 0);
  });

  test('independent wide obligation fuzz has 1000 distinct sequences and visible post-scroll steps', t => {
    const result = runStageObligationFuzz(host(), { frame, cases: 1000, wide: true, area: true });
    assert.deepEqual(result.violations, [], JSON.stringify(result));
    assert.equal(result.distinctSequences, 1000); assert.equal(result.stats.intersections, 0);
    assert.ok(result.stats.visibleAfterScroll > 0); assert.ok(result.stats.visibleByMode[6] > 0 && result.stats.visibleByMode[7] > 0);
    t.diagnostic('CA1 obligations ' + JSON.stringify(result));
  });

  test('recorded scene replays report visibility without claiming live qualification', async t => {
    const { installStageCharacter, replayStageSequence } = await import('../bench/hand/stage-live.mjs');
    const character = installStageCharacter(root).frame;
    for (const stress of [false, true]) {
      const replay = await replayStageSequence(host(), character, { root, stress });
      const times = Array.from({ length: 62 }, (_, i) => i);
      const samples = times.map(t => replay.samples.findLast(s => s.time <= t));
      const visible = samples.filter(s => s?.shown).length;
      assert.ok(replay.geometryOnly && replay.throughRing);
      t.diagnostic(`CA1 replay baseline=${!!process.env.CA1_BASELINE_SOURCE} stress=${stress} visible=${visible}/${samples.length}`);
    }
  });

  test('replay sample denominator includes saved times beyond the duration interval', async () => {
    const { areaReplaySamples } = await import('../scripts/replay-stage-area.mjs');
    assert.deepEqual(areaReplaySamples([{ time: 0, shown: true }, { time: 1, shown: false }, { time: 61, shown: true }],
      [0, 0.5, 1, 61, 61.1]), [true, true, false, true, true]);
  });
});
