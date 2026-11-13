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
import { runStageObligationFuzz } from './fixtures/stage-stateful-fuzz.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-area-review-'))));
after(() => rmSync(root, { recursive: true, force: true }));
const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const binaries = new Map();
const mutations = {
  'missing-wide-frame': ['out += wideFrames(world)', '// missing wide frames'],
  'wide-forgets-old-boxes': ['world.base.above + world.cards + activeTargets', 'world.base.above + world.cards + (wideWindows.isEmpty ? activeTargets : [])'],
  'stale-hides-nothing': ['retainWide(key, box: measured.union(observed).insetBy(dx: -48, dy: -48))', '// stale frame ignored'],
  'drag-destination-ignored': ['if let destination = world.orderedWindows.first', 'if false, let destination = world.orderedWindows.first'],
  'capacity-drops-oldest': ['if !box.isNull { retainWide(key, box: box) }', 'wideRecords[key] = windowBook.current[key]!.bounds.insetBy(dx: -48, dy: -48)'],
  'pending-destination-dropped': ['pendingDrops.append(ev.at)', '// pending destination dropped'],
};
const pendingHide = 'if !pendingDrops.isEmpty { return hide("drag-destination-pending", immediate: true) }';
const pendingMutations = { 'pending-pause-hide-deleted': 0, 'pending-update-hide-deleted': 1 };
function host(variant = 'product') {
  if (binaries.has(variant)) return binaries.get(variant);
  let text = source;
  if (variant in pendingMutations) {
    const parts = text.split(pendingHide);
    assert.equal(parts.length, 3, 'exactly two production pending-hide sites');
    const site = pendingMutations[variant];
    parts[site] += '// pending hide deleted';
    text = parts[0] + (site === 0 ? '' : pendingHide) + parts[1] + (site === 1 ? '' : pendingHide) + parts[2];
  } else if (variant !== 'product') {
    const [before, after] = mutations[variant];
    assert.equal(text.split(before).length - 1, 1, variant + ' one production mutation site');
    text = text.replace(before, after);
  }
  const file = join(root, variant + '.swift'), binary = join(root, variant);
  writeFileSync(file, text);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); binaries.set(variant, binary); return binary;
}
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const frame = { hand: 'character', nonce, seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null, cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 208], table: Object.fromEntries(states.map(s => [s, entry])) }, size: 'medium' };
const a = { id: 7, pid: 42, frame: [100, 600, 500, 250] }, b = { id: 9, pid: 43, frame: [900, 600, 500, 250] };
const world = (windows = [a, b], more = {}) => ({ dumpWorld: { windows, displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
  person: [1650, 1050, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10, cards: [], ...more } });
const aim = (seq, w = a) => ({ hand: 'aim', nonce, seq, kind: 'click', pid: w.pid, windowId: w.id, at: [w.frame[0] + 250, w.frame[1] + 200] });
const drag = (seq, path = [[350, 800], [1100, 800]]) => ({ hand: 'act', nonce, seq, kind: 'drag', pid: a.pid, windowId: a.id, at: [1100, 800], path, beats: 1, delayMs: 0 });
const stats = { dumpStats: true };
function dump(lines, variant = 'product') {
  const result = spawnSync(host(variant), ['--stage-dump'], { input: [frame, { dumpStageArt: true }, world(), ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 << 20 });
  assertChildStatus(result, 0, result.stderr || result.stdout.slice(-2000));
  return result.stdout.trim().split('\n').map(JSON.parse).filter(r => r.effect === 'stage-stats');
}
const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
const contains = (r, s) => r[0] <= s[0] + 1e-6 && r[1] <= s[1] + 1e-6 && r[0] + r[2] >= s[0] + s[2] - 1e-6 && r[1] + r[3] >= s[1] + s[3] - 1e-6;
function covered(row, rect, message) { assert.ok(row.forbidden.some(r => contains(r, rect)), message + ': missing protected coverage'); }
const exact = (op, ev, w, extra = {}) => ({ dumpTransaction: { op, now: 1, reduced: false, flags: { stageArt: true }, provider: false, art: [],
  world: w, ...ev ? { event: { state: 'drag', pid: a.pid, window: a.id, at: [1100, 800], ok: false, end: null, ...ev }, seq: 3, rect: null } : {}, ...extra } });
const exactWorld = (acting = a, ordered = [a, b]) => ({ window: acting.frame, display: [0, 0, 1800, 1200], usable: [0, 30, 1800, 1140],
  top: 30, above: [], cards: [], person: [1650, 1050, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10,
  stageAvailable: true, windows: [b], orderedWindows: ordered.map(({ pid, id }) => ({ pid, id })) });

function pendingRows(op, variant = 'product') {
  return dump([aim(2), stats,
    ...op === 'receive' ? [exact('receive', {}, exactWorld(a, []))]
      : [exact('admission', {}, null), exact('pause', null, null, { value: true })],
    stats, exact('pause', null, exactWorld(), { value: false }), stats], variant);
}
function assertPendingHidden(rows) {
  assert.equal(rows[0].shown, true, 'the character draws before the unresolved drop');
  assert.equal(rows[1].shown, false, 'an unresolved drop must hide the character');
  assert.equal(rows[1].hiddenReason, 'drag-destination-pending', 'pending drop must decide the hide reason');
  assert.equal(rows[1].hideReasonCounts['drag-destination-pending'], 1);
  assert.equal(rows[2].shown, true, 'ordered windows allow the character to return');
  covered(rows[2], expand(b.frame), 'resolved pending destination');
  covered(rows[2], expand(a.frame), 'retained drag source');
}

describe('CAR3 area review regressions', { skip: macCommandSkip('xcrun'), timeout: 900000 }, () => {
  test('CH-7 drops stay pending without a world and resolve against known ordered windows', () => {
    for (const missing of [world([a, b], { missing: true }), world([]), world([b])]) {
      const rows = dump([aim(2), missing, drag(3), stats, world([a, b]), aim(4, b), stats]);
      const resolved = !missing.dumpWorld.missing && missing.dumpWorld.windows.length > 0;
      assert.equal(rows[0].shown, resolved, 'only an observed ordered destination permits an edge seat');
      if (resolved) {
        covered(rows[0], expand(a.frame), 'gone source remains protected');
        covered(rows[0], expand(b.frame), 'observed destination is wide');
        const panel = rows[0].presented.panel;
        assert.ok(rows[0].forbidden.every(r => !(panel[0] <= r[0] + r[2] && r[0] <= panel[0] + panel[2] &&
          panel[1] <= r[1] + r[3] && r[1] <= panel[1] + panel[3])), 'the panel clears all retained areas');
      }
      covered(rows[1], expand(b.frame), 'pending destination resolves on first ordered world');
      covered(rows[1], expand(a.frame), 'source stays protected');
    }
  });
  test('pending drops keep hiding without ordered windows and resolve while paused', () => {
    const rows = dump([aim(2), { dumpPaused: true }, exact('admission', {}, null),
      exact('pause', null, exactWorld(a, []), { value: true }), stats,
      exact('pause', null, exactWorld(), { value: true }), { dumpPaused: false }, aim(4, b), stats]);
    assert.equal(rows[0].shown, false);
    covered(rows[1], expand(b.frame), 'paused pending destination');
  });
  for (const op of ['receive', 'pause']) test('pending drop hide is decided by ' + op, () => {
    assertPendingHidden(pendingRows(op));
  });
  for (const [variant, site] of Object.entries(pendingMutations)) test('in-suite mutant rejects ' + variant, t => {
    const rows = pendingRows(site === 0 ? 'pause' : 'receive', variant);
    assert.throws(() => assertPendingHidden(rows), site === 0
      ? /pending drop must decide the hide reason/ : /an unresolved drop must hide the character/);
    t.diagnostic(JSON.stringify({ variant, shown: rows[1].shown, hiddenReason: rows[1].hiddenReason }));
  });
  test('a drag without an end still widens the window under at', () => {
    const row = dump([aim(2), exact('receive', {}, exactWorld()), aim(4, b), stats])[0];
    covered(row, expand(b.frame), 'empty drag path destination');
  });
  test('pending destination overflow stays hidden until the terminal frame', () => {
    const lines = Array.from({ length: 129 }, (_, i) => exact('receive', {}, null, { seq: i + 3 }));
    const rows = dump([...lines, stats, world(), stats,
      { hand: 'status', nonce, seq: 133, pid: a.pid, windowId: a.id, at: [350, 800], state: 'handback' }, stats]);
    assert.equal(rows[0].targetCapacity, true); assert.equal(rows[0].shown, false);
    assert.equal(rows[1].targetCapacity, true); assert.equal(rows[1].shown, false);
    assert.equal(rows[2].targetCapacity, false);
    assert.equal(rows[2].wideWindows.length, 0);
  });
  test('a resolved destination retains its first frame when it disappears before another poll', () => {
    const row = dump([aim(2), world([a, b], { missing: true }), drag(3), world(), world([a]), aim(4), stats])[0];
    covered(row, expand(b.frame), 'first resolved destination frame');
  });
  test('a first-time wide disappearance retains the last narrow frame', () => {
    const row = dump([aim(2), world([b]), aim(3, b), stats])[0];
    covered(row, expand(a.frame), 'disappeared narrow window frame');
  });
  test('a wide acting frame outside layer zero survives switching windows', () => {
    const row = dump([world([b]), exact('receive', {}, exactWorld()), world([b]), aim(4, b), stats])[0];
    covered(row, expand(a.frame), 'outside layer zero acting frame');
  });
  for (const variant of Object.keys(mutations)) test('in-suite mutant rejects ' + variant, () => {
    const binary = host(variant);
    const result = runStageObligationFuzz(binary, { frame, cases: 36, wide: true });
    assert.ok(result.violations.length, variant + ' must fail the independent oracle');
    assert.ok(result.violations.every(v => !v.error), 'no compiler, crash or timeout counts as detection: ' + JSON.stringify(result));
    assert.match(JSON.stringify(result.violations), /missing protected coverage|pending.*drew/, variant);
  });
});
