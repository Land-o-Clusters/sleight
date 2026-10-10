import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the rebased package preserves four test workers and both prose lists', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.test, 'node --test --test-concurrency=4 tests/*.test.mjs');
  for (const path of ['docs/design/windows.md', 'docs/benchmarks/2026-10-09-replay-desktop.md',
    'docs/benchmarks/2026-10-09-replay-desktop-2.md', 'docs/benchmarks/2026-10-10-simulator-focus.md',
    'docs/benchmarks/2026-10-10-save-lock.md', 'docs/benchmarks/2026-10-10-turn-lifecycle.md',
    'docs/benchmarks/2026-10-10-sim-savelock.md']) assert.ok(scripts['lint:prose'].split(' ').includes(path), path);
});
