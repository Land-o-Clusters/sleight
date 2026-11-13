import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';
import { macCommandSkip } from './requirements.mjs';

test('benchmark trace overflows without a partial replay or application startup', { skip: macCommandSkip('xcrun'), timeout: 900000 }, t => {
  const root = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'sleight-trace-native-'))));
  const main = join(root, 'main.swift'), binary = join(root, 'host');
  copyFileSync(new URL('../plugins/sleight/lib/direct-browser/native/consent-host.swift', import.meta.url), main);
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-D', 'SLEIGHT_STAGE_BENCH', '-module-cache-path', join(root, 'modules'), main,
    new URL('../bench/hand/stage-fixture.swift', import.meta.url).pathname, '-o', binary],
  { encoding: 'utf8', timeout: 600000, killSignal: 'SIGKILL' });
  assertChildStatus(built, 0, built.stderr);
  const result = spawnSync(binary, ['--stage-bench', '--trace-self-test'], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
  assertChildStatus(result, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.recordsBeforeOverflow, 1);
  assert.equal(row.recordsAfterOverflow, 1);
  assert.equal(row.complete, false);
  assert.ok(row.bytes <= row.limit);
  assert.equal(row.windowRecords, 128); assert.equal(row.windowOverflow, true);
  assert.equal(row.capacityHide, true, '129 simultaneous windows must hide'); assert.equal(row.overflowShown, false);
  assert.equal(row.oversizedWorldComplete, false);
  assert.equal(row.windowsCreated, 0); assert.equal(row.captures, 0);
  t.diagnostic(JSON.stringify(row));
});
