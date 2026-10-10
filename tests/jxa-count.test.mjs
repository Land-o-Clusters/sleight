import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

// In JXA an NSArray's count isn't a JS number, so `arr.count !== 1` is always true. It made the
// exact-text probe refuse with "Ambiguous TextEdit process" while one TextEdit ran (2026-10-10).
test('JXA helpers compare an ObjC count only through Number()', () => {
  const offenders = [];
  for (const dir of ['bench', 'plugins/sleight/lib']) {
    for (const name of readdirSync(new URL(`../${dir}/`, import.meta.url)).filter(f => f.endsWith('.js'))) {
      readFileSync(new URL(`../${dir}/${name}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
        if (!/JS number/.test(line) && /(?<!Number\()\b[\w.]+\.count\s*[!=]==?|[!=]==?\s*[\w.]+\.count\b/.test(line)) offenders.push(`${dir}/${name}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});
