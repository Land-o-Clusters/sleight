import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';
import { auditStageObligations } from './fixtures/stage-stateful-fuzz.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-certified-remap-'))));
after(() => rmSync(root, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  const original = new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  let source = readFileSync(original, 'utf8');
  const variants = {
    'no-certified-remapping': s => s.replace('guard validGeometryCertificate(proof, world: world) else', 'guard false && validGeometryCertificate(proof, world: world) else'),
    'accept-reused-incarnation': s => s.replace('prior.incarnation == proof.incarnation,', ''),
    'accept-partial-remap': s => s.replace('Set(proof.references.map { $0.seq }) == sequences', 'Set(proof.references.map { $0.seq }).isSubset(of: sequences)'),
    'merge-departed-into-visible': s => s.replace('$0.epoch == epoch && !$0.outside', '$0.epoch == epoch'),
    'accept-stale-observation': s => s.replace('proof.after == admissionWatermarks[proof.key, default: -1]', 'proof.after <= admissionWatermarks[proof.key, default: -1]'),
  };
  if (process.env.CHRET4_REMAP_VARIANT) {
    const changed = variants[process.env.CHRET4_REMAP_VARIANT]?.(source);
    assert.ok(changed && changed !== source, 'production remap mutation site'); source = changed;
  }
  const input = join(root, 'host.swift'); writeFileSync(input, source);
  binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); return binary;
}
const nonce = 'a'.repeat(64), bounds = [200, 500, 900, 350];
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false,
  hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const states = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait',
  'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = { hand: 'character', nonce, seq: 1, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } },
  perch: { anchor: [96, 150], table: Object.fromEntries(states.map(state => [state, entry])) }, size: 'stage' };
const world = (frame = bounds, visible = true) => ({ dumpWorld: { windows: [{ id: 7, pid: 42, frame, onScreen: visible }],
  displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }], pointer: [1750, 1150], inputAge: 20,
  pointerAway: 10, person: [1450, 700, 300, 300], cards: [] } });
const aim = (seq, more = {}) => ({ hand: 'aim', nonce, seq, kind: 'click', pid: 42, windowId: 7, at: [650, 700], ...more });
const proof = (seq, more = {}) => ({ hand: 'stage-geometry', nonce, seq, geometry: { pid: 42, windowId: 7,
  incarnation: 'b'.repeat(32), observation: 1, contentGeneration: 0, after: -1, mode: 'baseline', bounds, references: [], ...more } });
const clock = dumpClock => ({ dumpClock }), stats = { dumpStats: true };
function dump(lines, ok = 0) {
  const result = spawnSync(host(), ['--stage-dump'], { input: [character, { dumpStageArt: true }, world(), ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 });
  assertChildStatus(result, ok, result.stderr || result.stdout.slice(-2000));
  return result.stdout.trim() ? result.stdout.trim().split('\n').map(JSON.parse) : [];
}
const samples = rows => rows.filter(r => r.effect === 'stage-stats');
const moved = [250, 500, 900, 350];
const move = more => proof(4, { observation: 2, after: 3, mode: 'move', bounds: moved, ...more });
const prefix = () => [proof(2), aim(3), clock(1), world(moved), stats];
const scroll = (seq = 4) => ({ hand: 'act', nonce, seq, kind: 'scroll', pid: 42, windowId: 7, at: [650, 700], rect: [620, 680, 60, 30], path: [[650, 700]], delayMs: 0, beats: 1 });
const refs = [{ seq: 3, rects: [[650, 650, 1, 1]], departed: false }, { seq: 4, rects: [[620, 680, 60, 30]], departed: false }];
const scrolled = (more = {}) => proof(5, { mode: 'scroll', after: 4, observation: 2, contentGeneration: 1, references: refs, ...more });
const scrollPrefix = () => [proof(2), aim(3), clock(1), scroll(), stats];

function assertWideSeat(row) {
  assert.equal(row.shown, true, 'a clear screen-edge seat stays visible while the window remains wide');
  assert.ok(row.wideWindows.some(k => k.pid === 42 && k.id === 7));
  const expanded = [152, 452, 996, 446]; // Original bounds plus the 48 pt margin.
  assert.ok(row.forbidden.some(r => r[0] <= expanded[0] && r[1] <= expanded[1] &&
    r[0] + r[2] >= expanded[0] + expanded[2] && r[1] + r[3] >= expanded[1] + expanded[3]), 'certificate cannot narrow retained window protection');
  const box = row.presented.box;
  assert.ok(row.forbidden.every(r => !(box[0] < r[0] + r[2] && box[0] + box[2] > r[0] && box[1] < r[1] + r[3] && box[1] + box[3] > r[1])), 'visible edge seat clears all retained areas');
}
const options = { skip: macCommandSkip('xcrun') };
test('certified move protects translated geometry and retains the wide area', options, t => {
  const rows = dump([...prefix(), move(), clock(2), stats]);
  const [before, after] = samples(rows);
  assertWideSeat(before);
  assertWideSeat(after);
  assert.equal(after.targetUnmapped, false);
  assert.equal(after.contributors, before.contributors);
  assert.ok(after.targetBindings.some(b => b.rect[0] === 652 && b.rect[1] === 652), 'verified translated location protected');
  const audit = auditStageObligations([{ pid: 42, window: 7, seq: 3, rects: [[652, 652, 96, 96]] }], after, world(moved).dumpWorld);
  assert.deepEqual(audit.errors, [], 'certified move protected intersections'); t.diagnostic('certified move audit ' + JSON.stringify(audit));
});
test('scroll certificate maps every retained reference and retains the wide area', options, t => {
  const [before, after] = samples(dump([...scrollPrefix(), scrolled(), clock(2), stats]));
  assertWideSeat(before); assertWideSeat(after);
  assert.equal(after.targetUnmapped, false);
  assert.deepEqual(new Set(after.targetBindings.flatMap(b => b.contributors.map(c => c.seq))), new Set([3, 4]));
  const obligations = refs.map(ref => ({ pid: 42, window: 7, seq: ref.seq, rects: ref.rects.map(r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96]) }));
  const audit = auditStageObligations(obligations, after, world().dumpWorld);
  assert.deepEqual(audit.errors, [], 'certified scroll protected intersections'); t.diagnostic('certified scroll audit ' + JSON.stringify(audit));
});
test('different window incarnation never certifies even with identical PID and bounds', options, () => {
  const row = samples(dump([...prefix(), move({ incarnation: 'c'.repeat(32) }), clock(2), stats])).at(-1);
  assertWideSeat(row); assert.equal(row.targetUnmapped, true);
});
test('partial reference inventory cannot remove wide protection', options, () => {
  const row = samples(dump([...scrollPrefix(), scrolled({ references: refs.slice(0, 1) }), clock(2), stats])).at(-1);
  assertWideSeat(row); assert.equal(row.targetUnmapped, true);
});
test('a certificate predating a newly admitted target cannot certify its mapping', options, () => {
  const stale = scrolled({ after: 4, references: [...refs, { seq: 5, rects: [[750, 700, 1, 1]], departed: false }] }); stale.seq = 6;
  const row = samples(dump([...scrollPrefix(), aim(5, { at: [750, 700] }), stale, clock(2), stats])).at(-1);
  assertWideSeat(row); assert.equal(row.targetUnmapped, true);
});
test('a visibility gap and missing baseline keep protection even when an identity token returns', options, () => {
  for (const lines of [[aim(2), clock(1), world(moved), move()], [...prefix(), world(moved, false), world(moved), move()]]) {
    const row = samples(dump([...lines, clock(2), stats])).at(-1);
    assertWideSeat(row); assert.equal(row.targetUnmapped, true);
  }
});
test('content generation changes forbid a move-only certificate and duplicate observation cannot recover', options, () => {
  for (const change of [{ contentGeneration: 1 }, { observation: 1 }]) {
    const row = samples(dump([...prefix(), move(change), clock(2), stats])).at(-1);
    assertWideSeat(row); assert.equal(row.targetUnmapped, true);
  }
});
test('proven departure keeps the contributor inventory until terminal completion', options, () => {
  const departed = refs.map(r => ({ ...r, rects: [], departed: true }));
  const rows = dump([...scrollPrefix(), scrolled({ references: departed }), stats,
    { hand: 'status', nonce, seq: 6, state: 'handback', pid: 42, windowId: 7, at: [650, 700] }, stats]);
  const s = samples(rows); assert.equal(s[1].contributors, s[0].contributors);
  assert.ok(s[1].activeTargets > 0, 'wide records retain old boxes despite a departure certificate'); assert.equal(s[2].contributors, 0);
});
test('stale window frames remain obligations even when they could not enter the geometry bank', options, () => {
  const lines = [...scrollPrefix(), aim(5, { windowRect: [0, 0, 100, 100], at: [800, 700] })];
  const incomplete = scrolled({ after: 5 }); incomplete.seq = 6;
  const row = samples(dump([...lines, incomplete, clock(2), stats])).at(-1);
  assertWideSeat(row);
  assert.equal(row.targetUnmapped, true);
  const complete = scrolled({ after: 5, references: [...refs, { seq: 5, rects: [[800, 700, 1, 1]], departed: false }] }); complete.seq = 6;
  const fixed = samples(dump([...lines, complete, clock(2), stats])).at(-1);
  assert.equal(fixed.targetUnmapped, false); assert.ok(fixed.targetBindings.some(b => b.contributors.some(c => c.seq === 5)));
});
test('a drag with unknown carried dimensions cannot be certified by reference rectangles', options, () => {
  const drag = { ...scroll(), kind: 'drag', path: [[600, 650], [650, 700]] };
  const row = samples(dump([proof(2), aim(3), drag, scrolled(), clock(2), stats])).at(-1);
  assertWideSeat(row); assert.equal(row.targetUnmapped, true);
});
test('invalid certificate syntax and duplicate sequence faults are rejected without drawing', options, () => {
  for (const change of [{ incarnation: 'window title' }, { observation: true }, { contentGeneration: -1 },
    { references: [refs[0], refs[0]] }, { references: [{ seq: 3, rects: [], departed: false }] }]) {
    dump([proof(2, change)], 65);
  }
  dump([proof(2), aim(3), proof(2)], 65);
});

test('a new visible reference cannot be swallowed by a certified departed record', options, () => {
  const departed = refs.map(r => ({ ...r, rects: [], departed: true }));
  const rows = dump([...scrollPrefix(), scrolled({ references: departed }), aim(6), stats]);
  const row = samples(rows).at(-1);
  assert.ok(row.targetBindings.some(b => b.outside === false && b.contributors.some(c => c.seq === 6)), 'new reference needs active geometry');
  const audit = auditStageObligations([{ seq: 6, pid: 42, window: 7, rects: [[602, 652, 96, 96]] }], row, world().dumpWorld);
  assert.deepEqual(audit.errors, []);
});

test('a changed incarnation at unchanged bounds retains wide protection beyond the certificate frame', options, () => {
  const rows = dump([proof(2), aim(3), proof(4, { mode: 'move', after: 3, observation: 2, incarnation: 'c'.repeat(32) }), clock(2), stats]);
  assertWideSeat(samples(rows).at(-1)); assert.equal(samples(rows).at(-1).targetUnmapped, true);
});
test('certified transactions replay their exact counts and draw plans without a bench nonce', options, async () => {
  const { stageReplayReceipt, stageReplayLines, compareStageReplay } = await import('../bench/hand/stage-trace.mjs');
  const trace = dump([{ dumpTrace: true }, ...scrollPrefix(), scrolled(), clock(2), { dumpTraceRead: true }]).find(r => r.effect === 'stage-trace');
  const receipt = stageReplayReceipt({ frame: character, trace, scenario: 'small-target-turn-lifecycle' });
  const replay = dump(stageReplayLines(receipt).slice(1)).find(r => r.effect === 'stage-trace');
  assert.deepEqual(compareStageReplay(trace, replay).mismatches, [], 'certified geometry replay changed');
  assert.equal(JSON.stringify(receipt).includes(nonce), false);
});

test('a complete move observation maps a stale frame that had no admissible old geometry', options, () => {
  const mapped = move({ after: 4, references: [{ seq: 3, rects: [[700, 700, 1, 1]], departed: false },
    { seq: 4, rects: [[750, 700, 1, 1]], departed: false }] }); mapped.seq = 5;
  const rows = dump([...prefix(), aim(4, { at: [750, 700], windowRect: bounds }), mapped, clock(2), stats]);
  const after = samples(rows).at(-1);
  assertWideSeat(after);
  assert.deepEqual(new Set(after.targetBindings.flatMap(b => b.contributors.map(c => c.seq))), new Set([3, 4]));
  const audit = auditStageObligations([{ seq: 3, pid: 42, window: 7, rects: [[652, 652, 97, 97]] },
    { seq: 4, pid: 42, window: 7, rects: [[702, 652, 97, 97]] }], after, world(moved).dumpWorld);
  assert.deepEqual(audit.errors, []);
});
