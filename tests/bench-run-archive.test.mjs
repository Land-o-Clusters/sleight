import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveOldRuns } from '../bench/run-archive.mjs';

test('old run folders move to the archive with their traces; recent runs and other files stay', () => {
  const root = mkdtempSync(join(tmpdir(), 'bench-archive-'));
  const bench = join(root, 'sleight-bench'), archive = join(root, 'archive');
  const old = join(bench, '2026-10-09T01-38-31-540Z'), recent = join(bench, '2026-10-10T11-17-52-572Z');
  for (const dir of [old, recent]) { mkdirSync(join(dir, 'run-1'), { recursive: true }); writeFileSync(join(dir, 'run-1', 'trace.jsonl'), '{}\n'); }
  writeFileSync(join(bench, 'notes.txt'), 'x');
  const now = Date.now();
  utimesSync(old, new Date(now - 7 * 3600 * 1000), new Date(now - 7 * 3600 * 1000));
  assert.deepEqual(archiveOldRuns(bench, archive, { now }), ['2026-10-09T01-38-31-540Z']);
  assert.ok(existsSync(join(archive, '2026-10-09T01-38-31-540Z', 'run-1', 'trace.jsonl')));
  assert.ok(existsSync(recent) && existsSync(join(bench, 'notes.txt')));
  assert.deepEqual(archiveOldRuns(join(root, 'missing'), archive, { now }), []);
});
