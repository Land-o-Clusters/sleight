import { test } from './macos-only.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native filters preserve exact case-insensitive app matching and document-window exclusions', () => {
  const result = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript',
    fileURLToPath(new URL('../bench/footprint-parity-filters.js', import.meta.url)),
    fileURLToPath(new URL('../plugins/sleight/lib/app-health.js', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  const { unicodeMatches, ...counts } = JSON.parse(result);
  assert.deepEqual(counts, { matches: [1, 1, 1, 0, 1], targetWindows: 3, otherWindows: 1, absentWindows: 0 });
  for (const row of unicodeMatches) assert.equal(row.native, row.original, row.selector);
});
