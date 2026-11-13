import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const cli = fileURLToPath(new URL('../bench/hand/check4.mjs', import.meta.url));
// Canonical system temporary root. Check 4 admits only a child of this directory, so the root itself is refused.
const systemTemp = realpathSync('/tmp');
const outside = join(dirname(systemTemp), 'sleight-check4-refused');
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
  env: { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? '/nonexistent' } });

test('the live entry settles: a refusal inside the live module exits 1 with its reason, never 13', () => {
  // check4-live.mjs imports check4.mjs back; a top-level await on main() deadlocked that cycle (exit 13, 2026-11-04).
  const r = run(['--drive', 'model', '--owner-away', '--out', systemTemp]);
  assert.notEqual(r.status, 13, r.stderr);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Check 4 stopped:/);
});

test('an output folder outside the private temporary bank is refused before the live lock is taken', () => {
  const lockBefore = existsSync('/tmp/sleight-live.lock');
  const r = run(['--drive', 'model', '--owner-away', '--out', outside]);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stderr.includes(`--out must be under ${systemTemp}/`), r.stderr);
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync('/tmp/sleight-live.lock'), lockBefore);
});
