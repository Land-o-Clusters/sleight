import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { sampleWindows, createWindowSampler } from '../bench/hand/check4-measurement.mjs';
const source = fileURLToPath(new URL('../bench/hand/check4-sampler.swift', import.meta.url));
let binary;
function build() {
  if (binary) return binary;
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-check4-sampler-'))), main = join(root, 'main.swift');
  let text = readFileSync(source, 'utf8');
  if (process.env.CA6_BROKEN_VARIANT === 'host-geometry') {
    const original = 'let frame = panels.count == 1 ? rectangle(panels[0]["frame"]) : nil';
    assert.ok(text.includes(original)); text = text.replace(original, 'let frame = rectangle(host["panel"])');
  }
  if (process.env.CA6_BROKEN_VARIANT === 'stale-protection') {
    const original = 'let protection = valid && windows != nil ? status : lastValidStatus';
    assert.ok(text.includes(original)); text = text.replace(original, 'let protection = valid && windows != nil ? status : nil');
  }
  writeFileSync(main, text);
  const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(root, 'modules'), main, '-o', join(root, 'sampler')],
    { encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); return binary = join(root, 'sampler');
}
const status = { pid: 40, panelID: 7, hostTimeMs: 1000, panel: [900, 900, 20, 20], wideWindows: [{ pid: 42, id: 9, frame: [0, 0, 10, 10] }], protectedRects: [] };
const input = { t: 1000, status, appPids: [42], windows: [
  { pid: 40, id: 7, frame: [158, 50, 20, 20], alpha: 1 }, { pid: 42, id: 9, frame: [100, 50, 10, 10], alpha: 1 }] };
function native(rows) {
  const result = spawnSync(build(), ['--selftest'], { input: rows.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8',
    timeout: 10000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr); return result.stdout.trim().split('\n').map(JSON.parse);
}
test('Swift sampler uses the window list even when both host frames are wrong', { skip: process.platform !== 'darwin' }, () => {
  const [row] = native([input]);
  assert.deepEqual(row.panel.frame, [158, 50, 20, 20]);
  assert.equal(row.intersections.length, 1);
  assert.equal(row.intersections[0].kind, 'wide-window');
  assert.deepEqual(row, sampleWindows(input));
});
test('native and JS sampling agree on missing, transparent, protected and stale evidence', { skip: process.platform !== 'darwin' }, () => {
  const rows = [input, { ...input, windows: [] }, { ...input, status: null }, { ...input, t: 1200 },
    { ...input, windows: [{ ...input.windows[0], alpha: 0 }] },
    { ...input, status: { ...status, wideWindows: [], protectedRects: [[150, 50, 8, 10]] } }];
  assert.deepEqual(native(rows), rows.map(createWindowSampler()));
});
test('SF3: native stale ticks retain both protection sets and read the moved wide frame independently', { skip: process.platform !== 'darwin' }, () => {
  const initial = { ...input, status: { ...status, protectedRects: [[158, 50, 20, 20]] },
    windows: [input.windows[0], { ...input.windows[1], frame: [500, 500, 10, 10] }] };
  const stale = { ...input, t: 1200, status: { ...status, pid: 99, panelID: 99, wideWindows: [], protectedRects: [] } };
  const missing = { ...input, t: 1250, status: null };
  const rows = native([initial, stale, missing]);
  assert.equal(rows[0].intersections.length, 1); // Protected rectangle contact already exists, the wide window then moves in.
  for (const row of rows.slice(1)) {
    assert.equal(row.valid, false);
    assert.equal(row.intersections.length, 2);
    assert.equal(row.panel.pid, 40);
    assert.deepEqual(row.intersections[0].frame, [52, 2, 106, 106]);
  }
  assert.deepEqual(rows, [initial, stale, missing].map(createWindowSampler()));
});
test('sampler source reads WindowServer and has no window or screenshot creation', () => {
  const text = readFileSync(source, 'utf8');
  assert.match(text, /CGWindowListCopyWindowInfo\(\[\.optionOnScreenOnly, \.excludeDesktopElements\]/);
  assert.doesNotMatch(text, /NSApplication\.shared|NSPanel\(|CGWindowListCreateImage\(|CGEventPost\(|SCStream\(/);
});
