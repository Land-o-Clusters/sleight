import { assertChildStatus } from './fixtures/child-status.mjs';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
const folder = trackTemp(realpathSync(mkdtempSync(join(tmpdir(), 'sleight-edge-chip-'))));
after(() => rmSync(folder, { recursive: true, force: true }));
test('1,000 chip placements stay above content and between clamps, or hide', { skip: macCommandSkip('xcrun') }, () => {
  const binary = join(folder, 'host');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url).pathname, '-o', binary], { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const nonce = 'a'.repeat(64);
  const act = (clock, transfer, windowId = 7, extra = {}) => ({ clock, hand: 'act', nonce, seq: clock + 1, kind: 'key', pid: 42, windowId, at: [500, 400], path: [[500, 400]], delayMs: 0, beats: 1, ...transfer ? { transfer } : {}, ...extra });
  const mood = frames => spawnSync(binary, ['--honest-mood-dump'], { input: frames.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  const moods = mood([act(0, 'take'), act(1, 'give', 8), act(2), act(3, 'take'), act(34, 'give', 9), act(35, 'take'), act(36, 'give'),
    { clock: 37, hand: 'status', nonce, seq: 38, pid: 42, windowId: 7, state: 'waiting', detail: 'payment' }, act(38, undefined, 7, { retry: true })]);
  assertChildStatus(moods, 0, moods.stderr);
  const cues = moods.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(cues.map(c => c.carrying), [false, true, false, false, false, false, false, false, false]);
  assert.equal(cues[7].detail, 'payment'); assert.equal(cues[8].retry, true);
  for (const bad of [{ transfer: 'secret' }, { transfer: 'take', kind: 'type' }, { retry: 1 }, { retry: 'true' }, { detail: 'secret' }]) assertChildStatus(mood([act(0, undefined, 7, bad)]), 65);

  let seed = 17; const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 * n; };
  const cases = Array.from({ length: 1000 }, (_, i) => ({ window: [rand(800), rand(600), 40 + rand(1500), 400], usable: [0, 30, 1800, 1000], excluding: i % 2 ? [[rand(1800), rand(600), 300, 200]] : [] }));
  cases.push({ window: [200, 300, 900, 500], usable: [0, 30, 1800, 1000], excluding: [] });
  cases.push({ ...cases.at(-1), excluding: [[900, 250, 200, 100]] });
  const result = spawnSync(binary, ['--edge-chip-dump'], { input: cases.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const rows = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1002); assert.ok(rows[1000].rect); assert.equal(rows[1001].rect, null);
  const overlaps = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
  rows.forEach((row, i) => {
    assert.equal(row.capture, 'none'); if (!row.rect) return;
    const [x, y, w, h] = row.rect, target = cases[i].window;
    assert.ok(x >= target[0] + 80); assert.ok(x + w <= target[0] + target[2] - 80);
    assert.ok(y + h <= target[1]); assert.equal(overlaps(row.rect, target), false);
    for (const excluded of cases[i].excluding) assert.equal(overlaps(row.rect, excluded), false);
  });
});
