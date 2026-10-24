import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBrowserFixture } from './browser-fixtures.mjs';
import { jobKinds, gradeJob } from './job-fixtures.mjs';

// Only the round grader inherits this descriptor; agent children receive their own stdio.
export function fixtureGradeDescriptor(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-fixture-grade-'));
  let fd;
  try {
    const file = join(dir, 'key');
    writeFileSync(file, JSON.stringify({ kind: fixture.kind, expected: fixture.expected }), { mode: 0o600, flag: 'wx' });
    fd = openSync(file, 'r');
    rmSync(dir, { recursive: true });
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

let privateFixture;
export function readFixtureExpected(task) {
  if (privateFixture === undefined) {
    let owned = false;
    try {
      const stat = fstatSync(3);
      owned = stat.isFile();
      privateFixture = owned && stat.size <= 65536 ? JSON.parse(readFileSync(3, 'utf8')) : null;
    } catch { privateFixture = null; }
    finally { if (owned) closeSync(3); }
  }
  return privateFixture?.kind === task.worldFixture ? privateFixture.expected : undefined;
}

export function gradeFixture({ task, site, answer, expected }) {
  if (jobKinds.includes(task.worldFixture)) return gradeJob({ task, site, answer, expected });
  if (!task.worldFixture) return { ok: true, cell: 'n/a', problems: [] };
  let result;
  try {
    if (site?.kind !== task.worldFixture || !Array.isArray(site.views) || !expected) throw Error('invalid fixture snapshot');
    const text = String(answer ?? '');
    const line = text.split('\n').filter(line => /^RESULT:/.test(line)).at(-1);
    result = checkBrowserFixture({ ...site, expected }, line ? line.slice(7).trim() : text);
  } catch { result = 'WORLD_FIXTURE_UNAVAILABLE'; }
  const problems = result === true ? [] : [result];
  return { ok: problems.length === 0, cell: problems.length ? `FAIL: ${result}` : 'ok', problems };
}
