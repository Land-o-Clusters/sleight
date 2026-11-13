import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';

const root = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-chvis-'))));
after(() => rmSync(root, { recursive: true, force: true }));
let binary;
function host() {
  if (binary) return binary;
  const source = process.env.CHVIS_BASELINE_SOURCE ?? new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url);
  const file = join(root, 'host.swift'); writeFileSync(file, readFileSync(source));
  binary = join(root, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), file, '-o', binary],
    { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr); return binary;
}
const nonce = 'a'.repeat(64);
const entry = { sheet: 'sheet', row: 0, frames: [0, 1], ms: [200, 200], loop: true, flip: false, hotspot: [96, 104], size: [1536, 208], scale: 0.5 };
const keys = ['perch', 'perch-peek', 'perch-hop', 'perch-point-left', 'perch-point-right', 'sleep', 'high-five', 'perch-wait', 'startle', 'jumping', 'running-right', 'running-left', 'error', 'handoff', 'paused'];
const character = { hand: 'character', nonce, seq: 0, id: 'fixture', sheet: join(root, 'sheet.png'), extra: null, cell: [192, 208],
  table: { idle: { ...entry, frames: 2 } }, perch: { anchor: [96, 208], table: Object.fromEntries(keys.map(k => [k, entry])) }, size: 'stage', stageAttention: false };
const a = { id: 7, pid: 42, owner: 'Fixture', frame: [100, 500, 500, 300] };
const b = { id: 8, pid: 43, owner: 'Fixture', frame: [900, 500, 500, 300] };
const world = (windows = [a, b], more = {}) => ({ dumpWorld: { windows,
  displays: [{ frame: [0, 0, 1800, 1200], visible: [0, 30, 1800, 1140] }],
  person: [1650, 1050, 100, 100], pointer: [1790, 1190], inputAge: 20, pointerAway: 10, cards: [], ...more } });
const wide = (seq, extra = {}) => ({ hand: 'wide', nonce, seq, pid: 42, windowId: 7, epoch: 0, reason: 'read', ...extra });
const aim = (seq, extra = {}) => ({ hand: 'aim', nonce, seq, kind: 'click', pid: 42, windowId: 7, at: [350, 700], ...extra });
const stats = { dumpStats: true };
function dump(lines) {
  const result = spawnSync(host(), ['--stage-dump'], { input: [character, { dumpStageArt: true }, world(), ...lines].map(JSON.stringify).join('\n') + '\n',
    encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 ** 2 });
  assertChildStatus(result, 0, result.stderr || result.stdout.slice(-1000));
  return result.stdout.trim().split('\n').map(JSON.parse);
}
const latest = rows => rows.findLast(r => r.effect === 'stage-stats');
const contains = (r, s) => r[0] <= s[0] && r[1] <= s[1] && r[0] + r[2] >= s[0] + s[2] && r[1] + r[3] >= s[1] + s[3];
const expand = r => [r[0] - 48, r[1] - 48, r[2] + 96, r[3] + 96];
const options = { skip: macCommandSkip('xcrun'), timeout: 900000 };
test('CH-1 wide app name protects both PIDs and synthetic events admit zero point records', options, () => {
  const rows = dump([wide(1, { pid: undefined, windowId: undefined, app: 'Fixture' }), stats]);
  const row = latest(rows);
  assert.equal(row.wideWindows.length, 2); assert.equal(row.turnTargets, 0); assert.equal(row.contributors, 0);
  for (const w of [a, b]) assert.ok(row.forbidden.some(r => contains(r, expand(w.frame))));
});
test('CH-1 wide protection persists after a located action and a read in another window', options, () => {
  const row = latest(dump([wide(1), aim(2), wide(3, { pid: 43, windowId: 8 }), stats]));
  assert.equal(row.wideWindows.length, 2);
  for (const w of [a, b]) assert.ok(row.forbidden.some(r => contains(r, expand(w.frame))));
  assert.ok(row.shown); assert.ok(row.presented.panel);
});
test('CH-1 a terminal ignores late wide frames but accepts the next turn epoch', options, () => {
  const rows = dump([wide(1), { hand: 'status', nonce, seq: 2, state: 'handback', pid: 42, windowId: 7 },
    wide(3), stats, wide(4, { epoch: 1 }), stats]).filter(r => r.effect === 'stage-stats');
  assert.equal(rows[0].wideWindows.length, 0); assert.equal(rows[1].wideWindows.length, 1);
});
test('CH-1 the 129th wide window retains overflow hiding', options, () => {
  const windows = Array.from({ length: 129 }, (_, i) => ({ ...a, id: i + 1 }));
  const row = latest(dump([world(windows), wide(1, { windowId: undefined }), stats]));
  assert.equal(row.shown, false); assert.equal(row.targetCapacity, true);
});
test('CH-2 the panel accepts exact geometry and rejects AppKit displacement', options, () => {
  const rows = dump([{ dumpPanelCheck: { target: [100, 33, 200, 300], actual: [100, 57, 200, 300] } },
    { dumpPanelCheck: { target: [100, 33, 200, 300], actual: [100, 33, 200, 300] } }]).filter(r => r.effect === 'panel-check');
  assert.deepEqual(rows.map(r => r.accepted), [false, true]);
});
test('CH-3 a stage edge seat wins over a medium window seat', options, () => {
  const row = latest(dump([world([{ ...a, frame: [850, 129, 500, 250] }], {
    displays: [{ frame: [0, 0, 1512, 982], visible: [0, 33, 1512, 949] }], person: [20, 840, 220, 122], pointer: [10, 970], cards: [[450, 129, 1062, 32]] }),
    aim(1, { at: [1100, 400] }), stats]));
  assert.equal(row.presented.rung, 'stage'); assert.ok(['edge-hang', 'floor-stand'].includes(row.presented.seat.kind));
});
test('CH-7 gone windows retain their boxes while the character uses only edge seats', options, () => {
  const rows = dump([wide(1), world([]), stats, world([a]), stats]).filter(r => r.effect === 'stage-stats');
  assert.equal(rows[0].shown, true); assert.ok(['edge-hang', 'floor-stand'].includes(rows[0].presented.seat.kind));
  assert.ok(rows[0].forbidden.some(r => contains(r, expand(a.frame))));
  assert.equal(rows[1].shown, true); assert.equal(rows[1].wideWindows.length, 1);
});
test('CH-7 an app with no window keeps the person protected at the screen edge', options, () => {
  const row = latest(dump([world([], { person: [0, 30, 1000, 500] }), wide(1, { windowId: undefined }), stats]));
  assert.equal(row.shown, true); assert.equal(row.turnTargets, 0);
  assert.ok(row.forbidden.every(r => r[2] > 0 && r[3] > 0), 'windowless diagnostics retain valid rectangles');
  assert.ok(['edge-hang', 'floor-stand'].includes(row.presented.seat.kind));
});

test('CH-7 a window arriving after named acquisition is re-anchored and fully protected', options, () => {
  const rows = dump([world([]), wide(1, { pid: undefined, windowId: undefined, app: 'Fixture' }), stats,
    world([a]), stats]).filter(r => r.effect === 'stage-stats');
  assert.equal(rows[0].shown, true); assert.equal(rows[0].turnTargets, 0);
  assert.equal(rows[1].shown, true); assert.equal(rows[1].wideWindows.length, 1);
  assert.ok(rows[1].forbidden.some(r => contains(r, expand(a.frame))));
});
test('CH-1 1000 wide admissions fabricate zero point records and clear every independent panel boundary', options, () => {
  const lines = [];
  for (let i = 1; i <= 1000; i++) lines.push(wide(i, { reason: i % 2 ? 'scroll' : 'read' }), stats);
  const rows = dump(lines).filter(r => r.effect === 'stage-stats');
  assert.equal(rows.length, 1000);
  let shown = 0;
  const touches = (a, b) => a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];
  for (const row of rows) {
    assert.equal(row.turnTargets, 0); assert.equal(row.contributors, 0);
    if (row.shown) {
      shown++;
      assert.ok(row.forbidden.every(r => !touches(row.presented.panel, r)));
    }
  }
  assert.equal(shown, 1000);
});

test('CH-1 the first late wide frame after a point-only terminal is ignored', options, () => {
  const row = latest(dump([aim(1), { hand: 'status', nonce, seq: 2, state: 'handback', pid: 42, windowId: 7 }, wide(3), stats]));
  assert.equal(row.wideWindows.length, 0); assert.equal(row.turnTargets, 0);
});

test('CH-7 windowless worlds keep elevated banners protected and ignore transparent panels', options, () => {
  const win = (id, layer, alpha) => ({ kCGWindowNumber: id, kCGWindowOwnerPID: 42, kCGWindowLayer: layer,
    kCGWindowAlpha: alpha, kCGWindowBounds: { X: id * 10, Y: 33, Width: 200, Height: 80 } });
  const row = dump([{ dumpWindowMetadata: { windows: [win(1, 0, 1), win(2, 3, 1), win(3, 21, 0), win(4, 1000, 1)], appPids: [42] } }])
    .find(row => row.effect === 'stage-census');
  assert.deepEqual(row.windowlessAbove, [[10, 33, 200, 80], [20, 33, 200, 80]]);
});
