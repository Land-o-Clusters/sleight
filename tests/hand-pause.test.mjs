import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

let binary;
function run(t, frames) {
  if (!binary) {
    const dir = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-pause-'))));
    const output = join(dir, 'host');
    const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(),
      new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', output], { encoding: 'utf8', timeout: 120000 });
    assert.equal(built.status, 0, built.stderr); binary = output; t.diagnostic(`binaryBytes=${statSync(binary).size}`);
  }
  const result = spawnSync(binary, ['--pause-control-dump'], { encoding: 'utf8', input: frames.map(f => JSON.stringify(f)).join('\n') + '\n', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map(JSON.parse);
}
const options = { skip: macCommandSkip('xcrun') };
test('retiring a shared control requires an exact parent nonce and cannot be requested by a worker', options, t => {
  const rows = run(t, [
    { exitFrame: { hand: 'control-exit', nonce: 'a'.repeat(64) } },
    { exitFrame: { hand: 'control-exit', nonce: 'b'.repeat(64) } },
    { exitFrame: { hand: 'control-exit', nonce: 'a'.repeat(64), extra: true } },
    { exitFrame: { hand: 'control-exit' } },
  ]);
  assert.deepEqual(rows.map(row => row.exitAccepted), [true, false, false, false]);
});
test('shared person input spends events across controls in one window and tracks other windows separately', options, t => {
  const rows = run(t, [
    { click: { pid: 0, consumer: 'shared', windowNumber: 0 } },
    { click: { reuse: true }, ack: true },
    { click: { pid: 0 }, ack: true },
    { click: { reuse: true, consumer: 'shared', windowNumber: 0 } },
    { click: { pid: 0, consumer: 'shared', windowNumber: 42, age: 1 } },
    { click: { reuse: true, consumer: 'shared', windowNumber: 42 } },
    { click: { pid: 0, consumer: 'shared', windowNumber: 0, age: 1 } },
    { click: { pid: 0, noNonce: true } },
    { click: { reuse: true, consumer: 'shared', windowNumber: 0 } },
  ]);
  assert.deepEqual(rows.map(row => row.accepted), [true, false, true, false, true, false, false, false, false]);
  assert.equal(rows[0].paused, false);
  assert.equal(rows[2].paused, true);
});
test('real control spends fresh hardware input and refuses stale, reused, nil, AX and wrong-source input', options, t => {
  const rows = run(t, [
    ...[{ pid: 42 }, { pid: 0, age: 5.1 }, { pid: 0, age: -1 }, { pid: 0, wrongSource: true },
      { pid: 0, userData: 1 }, { pid: 0, nil: true }, { pid: 0, wrongWindow: true }, { pid: 0, ax: true }].map(click => ({ click })),
    { click: { pid: 0 }, ack: true }, { click: { reuse: true }, ack: true },
    { click: { pid: 0, type: 'key' }, ack: true }, { ax: true }, { click: { pid: 0, age: 1 }, ack: true },
  ]);
  assert.deepEqual(rows.slice(0, 8).map(r => r.accepted), Array(8).fill(false));
  assert.deepEqual(rows.slice(8, 11).map(r => [r.accepted, r.paused]), [[true, true], [false, true], [true, false]]);
  assert.deepEqual(rows[8].events.map(e => e.phase), ['request', 'commit', 'confirm']);
  assert.ok(rows[8].events.every(e => e.hand === 'pause' && e.nonce === 'a'.repeat(64) && e.paused && /^[0-9a-f]{32}$/.test(e.token)));
  assert.equal(rows[12].accepted, false);
  assert.equal(rows[11].axPress, false); assert.equal(rows[11].axRefusals, 2); assert.equal(rows[11].paused, false);
  assert.equal(rows[0].canBecomeKey, false); assert.equal(rows[0].canBecomeMain, false);
  assert.equal(rows[0].nonactivating, true); assert.equal(rows[0].acceptsFirstMouse, true);
});
test('pause waits for acknowledgment, times out with a retry mark, and refuses a missing nonce', options, t => {
  const rows = run(t, [{ click: { pid: 0 } }, { expire: true }, { ack: true },
    { click: { pid: 0, noNonce: true } }, { click: { pid: 0 }, ack: true }]);
  assert.deepEqual(rows.map(r => r.paused), [false, false, false, false, true]);
  assert.equal(rows[0].pending, true); assert.equal(rows[1].failed, true); assert.equal(rows[1].pending, false);
  assert.deepEqual(rows[1].events.map(e => e.phase), ['cancel']);
  assert.equal(rows[3].accepted, false); assert.equal(rows[3].failed, true);
});
test('an old timeout cannot expire a new click, and a late relay rollback restores the displayed state', options, t => {
  const rows = run(t, [{ click: { pid: 0 }, ack: true }, { click: { pid: 0 } }, { oldTimer: true }, { ack: true }, { aborted: true }]);
  assert.equal(rows[2].pending, true); assert.equal(rows[2].failed, false);
  assert.equal(rows[3].paused, false); assert.equal(rows[4].paused, true); assert.equal(rows[4].failed, true);
});
test('sprite controls hit only opaque pixels, including scaled and flipped cells', options, t => {
  const [row] = run(t, [{ alphaCheck: true }]);
  assert.equal(row.opaque, true); assert.equal(row.flipped, true);
  for (const key of ['transparent', 'translucent', 'outside']) assert.equal(row[key], false, key);
});
test('idle control footprint in dump mode has no windows', options, t => {
  const [row] = run(t, [{ idleMs: 2000 }]);
  assert.ok(row.idleSeconds >= 1.9); assert.equal(row.windows, 0); assert.equal(row.controls, 1); assert.ok(row.rssBytes > 0);
  t.diagnostic(JSON.stringify(row));
});
test('chip and sprite bounds never overlap the target, flip at edges, and hide during drag', options, t => {
  const frames = [];
  for (const size of [[24, 24], [96, 104], [192, 208]]) for (const at of [[0, 0], [500, 500], [999, 999], [500, 990], [-40, 100]])
    frames.push({ at, size, clip: [0, 0, 1000, 1000] });
  frames.push({ at: [500, 500], size: [24, 24], clip: [0, 0, 1000, 1000], drag: true });
  const rows = run(t, frames);
  for (let i = 0; i < rows.length - 1; i++) {
    const [x, y, w, h] = rows[i].rect, [tx, ty] = frames[i].at;
    assert.ok(!(tx >= x && tx <= x + w && ty >= y && ty <= y + h));
    assert.ok(x >= 0 && y >= 0 && x + w <= 1000 && y + h <= 1000);
  }
  assert.equal(rows.at(-1).rect, null);
});
test('a delayed hit panel requires the same still-visible target bounds', options, t => {
  const expected = [0, 0, 800, 600];
  const rows = run(t, [expected, null, [20, 0, 800, 600], [0, 0, 700, 600]].map(observed => ({ validity: { expected, observed } })));
  assert.deepEqual(rows.map(r => r.current), [true, false, false, false]);
});
