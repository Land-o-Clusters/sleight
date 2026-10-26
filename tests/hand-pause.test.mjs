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
test('hardware source 0 alone can pause or resume; synthetic and missing event stubs fail closed', options, t => {
  const rows = run(t, [{ click: { pid: 42, type: 'up' } }, { click: { type: 'up' } }, { click: { pid: 0, type: 'key' } },
    { click: { pid: 0, type: 'up' } }, { click: { pid: 42, type: 'up' } }, { click: { pid: 0, type: 'up' } }]);
  assert.deepEqual(rows.map(r => r.paused), [false, false, false, true, true, false]);
  assert.deepEqual(rows.map(r => r.accepted), [false, false, false, true, false, true]);
  assert.equal(rows[0].canBecomeKey, false); assert.equal(rows[0].canBecomeMain, false);
  assert.equal(rows[0].nonactivating, true); assert.equal(rows[0].acceptsFirstMouse, true);
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
