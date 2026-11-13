import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { edgeWorld, expandWindow } from './fixtures/stage-edge-world.mjs';
import { placementFixtures } from '../bench/hand/stage-cost.mjs';
import { auditStageTrace } from './fixtures/stage-stateful-fuzz.mjs';
import { stageTraceLines, collectStageTrace } from './fixtures/stage-trace-chunks.mjs';
import { stageTraceVisibility, stageReplayReceipt, stageReplayLines, compareStageReplay } from '../bench/hand/stage-trace.mjs';

const source = readFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), 'utf8');
const folder = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-edge-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const keys = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const frame = { hand: 'character', nonce, seq: 0, id: 'fixture', sheet: '/tmp/stage-fixture/sheet.png', extra: null,
  cell: [192, 208], table: { idle: { ...entry, frames: 2 } }, perch: { anchor: [96, 208], table: Object.fromEntries(keys.map(k => [k, entry])) }, size: 'stage', stageAttention: false };
let seq = 0;
const aim = (more = {}) => ({ hand: 'aim', nonce, seq: ++seq, kind: 'click', pid: 42, windowId: 7, at: [900, 600], ...more });
const binaries = new Map();
function host(variant = 'product') {
  if (binaries.has(variant)) return binaries.get(variant);
  let text = source;
  if (variant.endsWith('window-only')) text = text.replace('for screenEdge in [false, true]', 'for screenEdge in [false]');
  if (variant.includes('live-fixture')) text = text.replace('above: windows[..<i].filter { $0.visible }.map { $0.rect }', 'above: []');
  if (variant === 'unpruned') {
    const changed = text.replace('if blockedSpan(lo, hi,', 'if false && blockedSpan(lo, hi,');
    assert.notEqual(changed, text, 'candidate span pruning site'); text = changed;
  }
  if (process.env.CA5_BROKEN_VARIANT === 'no-edge-seats') text = text.replace('for screenEdge in [false, true]', 'for screenEdge in [false]');
  if (variant === 'edge-seat-skips-clear' || process.env.CA5_BROKEN_VARIANT === 'edge-seat-skips-clear') {
    const changed = text.replace('for box in candidates where clear(box, world, pointer: avoidingPointer ? 40 : nil)',
      'for box in candidates where ["edge-hang", "floor-stand"].contains(kind) || clear(box, world, pointer: avoidingPointer ? 40 : nil)');
    assert.notEqual(changed, text, 'edge clear mutation site'); text = changed;
    // The span shortcut is also a clear check; this mutant must bypass it for edge seats.
    const unguarded = text.replace('if blockedSpan(lo, hi,', 'if !screenEdge && blockedSpan(lo, hi,');
    assert.notEqual(unguarded, text, 'edge span clear mutation site'); text = unguarded;
  }
  const input = join(folder, variant + '.swift'), output = join(folder, variant);
  writeFileSync(input, text);
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), input, '-o', output],
    { encoding: 'utf8', timeout: 900000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); binaries.set(variant, output); return output;
}
function dump(lines, { reduced = false, character = frame, variant = 'product', throughRing = false } = {}) {
  const result = spawnSync(host(variant), ['--stage-dump', ...reduced ? ['--reduce-motion'] : [], ...throughRing ? ['--through-ring'] : []], {
    input: [character, { dumpStageArt: true }, ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 900000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}
const latest = rows => rows.findLast(r => r.effect === 'stage');
const overlap = (a, b) => a[0] < b[0] + b[2] - 1e-7 && b[0] < a[0] + a[2] - 1e-7 && a[1] < b[1] + b[3] - 1e-7 && b[1] < a[1] + a[3] - 1e-7;
function audited(lines, options) {
  const rows = dump([{ dumpTrace: true }, ...lines, { dumpTraceRead: true }], options);
  const audit = auditStageTrace(collectStageTrace(rows));
  assert.deepEqual(audit.errors, [], JSON.stringify(audit));
  return rows;
}

describe('CA-5 screen-edge seats', { skip: macCommandSkip('xcrun'), timeout: 900000 }, () => {
test('top-only and bottom-only free regions seat outside wide windows', () => {
  for (const bottom of [false, true]) {
    const rows = audited([edgeWorld({ bottom }), aim()]);
    const p = latest(rows);
    assert.ok(p, 'free screen edge must seat: ' + JSON.stringify(rows));
    assert.equal(p.seat.kind, bottom ? 'floor-stand' : 'edge-hang');
    assert.equal(bottom ? p.box[1] + p.box[3] : p.box[1], bottom ? 1168.99 : 31.01);
  }
});

test('edge seats clear the person, pointer, above windows and cards, or hide', () => {
  const blockers = [
    { person: [0, 30, 1800, 322] },
    { pointer: [900, 100], cards: [[0, 352, 1800, 818], [0, 30, 810, 322], [990, 30, 810, 322]] },
    { windows: [{ id: 8, pid: 43, frame: [0, 30, 1800, 322] }, ...edgeWorld().dumpWorld.windows] },
    { cards: [[0, 30, 1800, 1140]] },
  ];
  for (const more of blockers) {
    const rows = audited([edgeWorld(more), aim(), { dumpStats: true }]);
    assert.equal(rows.findLast(r => r.effect === 'stage-stats').shown, false, 'blocked edge must hide');
  }
  for (const more of [{ person: [500, 30, 800, 322] }, { pointer: [900, 100] },
    { windows: [{ id: 8, pid: 43, frame: [500, 30, 800, 322] }, ...edgeWorld().dumpWorld.windows] }]) {
    const p = latest(audited([edgeWorld(more), aim()]));
    assert.ok(p, 'obstacle boundaries must find the remaining free span');
    assert.equal(p.seat.kind, 'edge-hang');
  }
});

test('span pruning preserves a free interval with the required panel gap', () => {
  const initial = edgeWorld(), baseline = latest(dump([initial, aim()]));
  const width = baseline.box[2], left = 500, right = left + width + 2.02;
  initial.dumpWorld.cards.push([0, 30, left, 322], [right, 30, 1800 - right, 322]);
  const lines = [initial, aim({ at: [left + width / 2, 600] })];
  const rows = dump(lines);
  assert.deepEqual(rows, dump(lines, { variant: 'unpruned' }));
  const placed = latest(rows);
  assert.equal(placed.seat.kind, 'edge-hang');
  assert.ok(Math.abs(placed.box[0] - left - 1.01) < 1e-6); assert.equal(placed.box[2], width);
});

test('in-suite edge-seat-skips-clear mutant fails the independent audit', () => {
  host('edge-seat-skips-clear'); // Compilation failures cannot satisfy the geometry assertion below.
  assert.throws(() => audited([edgeWorld({ cards: [[0, 30, 1800, 1140]] }), aim()],
    { variant: 'edge-seat-skips-clear' }), error => error.code === 'ERR_ASSERTION' && /protected intersection/.test(error.message));
});

test('a recorded no-seat hide exactly replays with every screen edge blocked', () => {
  const rows = audited([edgeWorld({ cards: [[0, 30, 1800, 1140]] }), aim()]);
  const trace = collectStageTrace(rows);
  assert.equal(trace.records.at(-1).output.hiddenReason, 'no-seat');
  const receipt = stageReplayReceipt({ frame, trace, scenario: 'full-window-scroll-stress' });
  const replay = spawnSync(host(), ['--stage-dump'], { input: stageReplayLines(receipt).map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 << 20 });
  assertChildStatus(replay, 0, replay.stderr);
  const captured = replay.stdout.trim().split('\n').map(JSON.parse).find(r => r.effect === 'stage-trace');
  assert.equal(compareStageReplay(trace, captured).reproduced, true);
  assert.equal(captured.records.at(-1).output.hiddenReason, 'no-seat');
});

test('CH-3 a full-size edge seat takes priority over smaller window seats', () => {
  const p = latest(audited([{ dumpWorld: { ...edgeWorld().dumpWorld, cards: [],
    windows: [{ id: 7, pid: 42, frame: [0, 300, 1800, 870] }] } }, aim()]));
  assert.ok(p); assert.ok(['edge-hang', 'floor-stand'].includes(p.seat.kind));
  assert.equal(p.rung, 'stage', 'a full-size edge seat must beat a smaller window seat');
});

test('an edge seat keeps its clear x across alternating acting windows without another pop', () => {
  const scene = edgeWorld({ cards: [] });
  scene.dumpWorld.windows.push({ ...scene.dumpWorld.windows[0], id: 9, pid: 43 });
  const scroll = { hand: 'act', nonce, seq: ++seq, kind: 'scroll', pid: 42, windowId: 7, at: [300, 600],
    path: [[300, 600]], delayMs: 0, beats: 1 };
  // Construct increasing wire sequences in send order.
  const first = aim({ at: [300, 600] }); scroll.seq = ++seq;
  const rows = audited([scene, first, scroll, { dumpClock: 1 }, aim({ pid: 43, windowId: 9, at: [1500, 600] })]);
  const draws = rows.filter(r => r.effect === 'stage' && r.seat.kind === 'edge-hang');
  assert.ok(draws.length >= 2);
  assert.equal(draws.at(-1).box[0], draws[0].box[0], 'reuse the still-clear edge span');
  assert.equal(draws.at(-1).opacity[0][1], 1, 'a stable edge seat must not pop again');
});

test('edge transitions pop in both directions and reduced motion stays still', () => {
  for (const reduced of [false, true]) {
    const window = { id: 7, pid: 42, frame: [0, 600, 1800, 570] };
    const normal = edgeWorld({ windows: [window], cards: [] });
    const blocked = edgeWorld({ windows: [window], cards: [expandWindow(window.frame)] });
    const rows = audited([normal, aim({ at: [900, 900] }), { dumpClock: 1 }, blocked, { dumpClock: 2 }, normal], { reduced });
    const draws = rows.filter(r => r.effect === 'stage');
    assert.ok(draws.some(r => r.seat.kind === 'edge-hang'));
    assert.ok(!['edge-hang', 'floor-stand'].includes(draws.at(-1).seat.kind));
    for (const r of draws.filter(r => r.time >= 1)) {
      assert.equal(r.positions.length, 1, 'screen edge moves must pop');
      assert.equal(r.opacity[0][1], 0);
      if (reduced) assert.equal(new Set(r.cells.map(c => c[4])).size, 1);
    }
  }
});

test('edge seats use the acting display usable bounds with negative global coordinates', () => {
  const w = edgeWorld().dumpWorld;
  const p = latest(audited([{ dumpWorld: { ...w,
    windows: [{ id: 7, pid: 42, frame: [-1600, 100, 1600, 900] }], cards: [[-1648, 52, 1696, 996]],
    displays: [...w.displays, { frame: [-1600, -400, 1600, 1400], visible: [-1600, -370, 1600, 1320] }],
  } }, aim({ at: [-800, 600] })]));
  assert.equal(p?.seat.kind, 'edge-hang'); assert.equal(p.box[1], -368.99);
  assert.ok(p.box[0] >= -1600 && p.box[0] + p.box[2] <= 0);
});

test('screen-edge seats select existing hang and stand art, including reduced motion', async () => {
  const { installStageCharacter } = await import('../bench/hand/stage-live.mjs');
  const character = { ...installStageCharacter(folder).frame, nonce, seq: 0, size: 'stage', stageAttention: false };
  for (const bottom of [false, true]) for (const reduced of [false, true]) {
    const p = latest(audited([{ dumpSyntheticArt: 'ready' }, edgeWorld({ bottom }), aim()], { character, reduced }));
    assert.equal(p?.artSource, bottom ? 'stage-stand' : 'stage-hang');
    assert.equal(p.positions.length, 1);
    if (reduced) assert.equal(new Set(p.cells.map(c => c[4])).size, 1);
  }
});

test('1000 placement seeds with wide-window fixtures have zero protected intersections', t => {
  const fixtures = Array.from({ length: 1000 }, (_, i) => placementFixtures({ seed: 0xca500001 + i, count: 1 })[0]);
  let visible = 0, hidden = 0, edgeSeats = 0, intersections = 0;
  const lines = [];
  for (const [i, f] of fixtures.entries()) {
    lines.push({ dumpClock: i * 2 }, { hand: 'status', nonce, seq: ++seq, state: 'handback', pid: 42, windowId: 7, at: [900, 600] },
      { dumpWorld: { windows: [...f.above.map((frame, i) => ({ id: i + 8, pid: 43, frame })), { id: 7, pid: 42, frame: f.target }],
        displays: [{ frame: f.display, visible: [0, 30, 2560, 1370] }], person: f.person,
        pointer: f.pointer, inputAge: 20, pointerAway: 10, cards: [],
      } }, { dumpClock: i * 2 + 0.6 }, aim({ at: f.aim, ...f.aimRect ? { rect: f.aimRect } : {} }),
      { hand: 'act', nonce, seq: ++seq, kind: 'scroll', pid: 42, windowId: 7, at: f.aim, path: [f.aim], delayMs: 0, beats: 1 }, { dumpStats: true });
  }
  const rows = dump(lines), stats = rows.filter(r => r.effect === 'stage-stats');
  assert.deepEqual(rows, dump(lines, { variant: 'unpruned' }), 'span pruning preserves every placement and protection receipt across 1000 seeds');
  assert.equal(stats.length, 1000);
  for (let i = 0; i < fixtures.length; i++) {
    const s = stats[i], f = fixtures[i];
    if (!s.shown) { hidden++; continue; }
    visible++;
    const p = s.presented;
    assert.ok(p, 'visible seed must expose its drawn box');
    if (['edge-hang', 'floor-stand'].includes(p.seat.kind)) edgeSeats++;
    for (const r of [expandWindow(f.target), f.person, ...f.above, [f.pointer[0] - 40, f.pointer[1] - 40, 80, 80],
      [f.aim[0] - 48, f.aim[1] - 48, 96, 96], ...f.aimRect ? [expandWindow(f.aimRect)] : []]) if (overlap(p.box, r)) intersections++;
  }
  assert.equal(intersections, 0); assert.ok(visible > 500 && edgeSeats > 500, JSON.stringify({ visible, hidden, edgeSeats }));
  t.diagnostic(JSON.stringify({ seeds: 1000, visible, hidden, edgeSeats, intersections }));
});

test('recorded scenes and check 3 reconstructions exceed 80 percent with production area protection', async t => {
  const { installStageCharacter, replayStageSequence } = await import('../bench/hand/stage-live.mjs');
  const { savedSampleCounts } = await import('../bench/hand/legacy-stage-world-check.mjs');
  const character = installStageCharacter(folder).frame;
  function auditWide(trace) {
    assert.equal(trace.complete, true, 'audit the complete scene');
    const audit = auditStageTrace(trace);
    assert.deepEqual(audit.errors, [], JSON.stringify(audit)); return audit;
  }
  const results = [];
  for (const stress of [false, true]) {
    const versions = [];
    for (const variant of ['wide-window-only', 'wide']) {
      let captured = '';
      // Exercise the real replayStageSequence entry point. Its only child must be the geometry dump.
      const spawnChild = (binary, args, options) => {
        assert.ok(args.includes('--stage-dump')); assert.ok(!args.includes('--stage-bench'));
        const child = spawn(binary, args, options), write = child.stdin.write.bind(child.stdin), end = child.stdin.end.bind(child.stdin);
        let first = true, written = 0;
        child.stdin.write = (chunk, ...rest) => {
          const result = write(chunk, ...rest);
          if (first) { first = false; write(JSON.stringify({ dumpTrace: true }) + '\n'); }
          if (++written % 128 === 0) write(JSON.stringify({ dumpTraceRead: true }) + '\n' + JSON.stringify({ dumpTrace: true }) + '\n');
          return result;
        };
        child.stdin.end = (...rest) => { write(JSON.stringify({ dumpTraceRead: true }) + '\n'); return end(...rest); };
        child.stdout.on('data', chunk => { captured += chunk; }); return child;
      };
      const replay = await replayStageSequence(host(variant), character, { root: folder, spawnChild, stress });
      assert.equal(replay.actions, 40);
      const rows = captured.trim().split('\n').map(JSON.parse), trace = collectStageTrace(rows);
      const audit = auditWide(trace), visibility = stageTraceVisibility(trace, { start: 0, end: 61 }), sampleTimes = Array.from({ length: 62 }, (_, i) => i);
      const counts = savedSampleCounts(rows, sampleTimes);
      versions.push({ variant, samples: 62, visible: 62 - (counts.hidden ?? 0), intersections: audit.intersections, pairs: audit.pairs, traceChunks: trace.chunks, traceRecords: trace.records.length, traceBytes: trace.bytes, visibility, planInstalls: rows.filter(r => r.effect === 'stage').length, popInstalls: rows.filter(r => r.effect === 'stage' && r.opacity[0][1] === 0).length });
    }
    assert.ok(versions[1].visible / versions[1].samples >= 0.8, JSON.stringify(versions));
    assert.equal(versions[1].visibility.measured, true, JSON.stringify(versions));
    assert.ok(versions[1].visibility.opacityShare >= 0.8, JSON.stringify(versions));
    results.push({ scene: stress ? 'headless-stress' : 'headless-lifecycle', versions });
  }
  const saved = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/stage-edge-check3.json.gz', import.meta.url))));
  for (const liveFixture of [false, true]) for (const [arm, fixture] of Object.entries(saved.arms)) {
    const versions = [];
    for (const suffix of ['window-only', '']) {
      const variant = 'wide' + (liveFixture ? '-live-fixture' : '') + (suffix ? '-' + suffix : '');
      const [character, ...lines] = fixture.lines;
      const rows = dump(stageTraceLines(lines), { character, variant, throughRing: true });
      const trace = collectStageTrace(rows), audit = auditWide(trace), visibility = stageTraceVisibility(trace, { start: 0, end: 61 });
      const counts = savedSampleCounts(rows, fixture.sampleTimes), samples = fixture.sampleTimes.length;
      versions.push({ variant, samples, visible: samples - (counts.hidden ?? 0), intersections: audit.intersections, pairs: audit.pairs, traceChunks: trace.chunks, traceRecords: trace.records.length, traceBytes: trace.bytes, visibility, planInstalls: rows.filter(r => r.effect === 'stage').length, popInstalls: rows.filter(r => r.effect === 'stage' && r.opacity[0][1] === 0).length });
    }
    assert.ok(versions[1].visible / versions[1].samples >= 0.8, JSON.stringify(versions));
    assert.equal(versions[1].visibility.measured, true, JSON.stringify(versions));
    assert.ok(versions[1].visibility.opacityShare >= 0.8, JSON.stringify(versions));
    results.push({ scene: `check3-${liveFixture ? 'live-fixture' : 'original-world'}-${arm}`, versions });
  }
  for (const row of results) t.diagnostic(JSON.stringify(row));

});
});
