import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real osascript, because the fakes elsewhere can't show a JXA bridging fault: Ref('CGPoint') read back as the number 0,
// so drag never matched a TextEdit window (textedit-drag, 2026-10-16). Building an AXValue needs no Accessibility trust.
const probe = `
function run() {
  const point = $.NSMutableData.dataWithLength(16), size = $.NSMutableData.dataWithLength(16);
  $.NSValue.valueWithPoint({ x: 152, y: 73 }).getValue(point.mutableBytes);
  $.NSValue.valueWithSize({ width: 656, height: 422 }).getValue(size.mutableBytes);
  return JSON.stringify([axPair($.AXValueCreate(1, point.bytes), 1), axPair($.AXValueCreate(2, size.bytes), 2)]);
}`;

for (const file of ['drag.js', 'window-identity.js', 'element-visibility.js']) {
  test(`${file} reads AX points and sizes through real JXA`, { skip: process.platform !== 'darwin' && 'macOS only' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-geometry-'));
    try {
      const script = join(dir, file);
      writeFileSync(script, readFileSync(new URL(`../plugins/sleight/lib/${file}`, import.meta.url), 'utf8') + probe);
      const out = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', script], { encoding: 'utf8', timeout: 20000 });
      assert.deepEqual(JSON.parse(out), [[152, 73], [656, 422]]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
