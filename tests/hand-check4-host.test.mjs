import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { trackTemp } from '../scripts/temp-leftovers.mjs';
import { buildCheck4 } from '../bench/hand/check4-build.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

test('optimized observation host links and reports wide state without creating a window', { skip: process.platform !== 'darwin', timeout: 900000 }, async () => {
  const root = trackTemp(mkdtempSync(join(tmpdir(), 'sleight-check4-host-')));
  const run = promisify(execFile);
  const binaries = await buildCheck4(root, (command, args, options) => run(command, args, { ...options, killSignal: 'SIGKILL' }));
  const endingPath = join(root, 'ending-status.json');
  const result = spawnSync(binaries.host, ['--stage-bench', '--status-selftest'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL',
    env: { ...process.env, SLEIGHT_CHECK4_STATUS: endingPath } });
  assertChildStatus(result, 0, result.stderr);
  const row = JSON.parse(result.stdout);
  assert.equal(row.windowsCreated, 0);
  assert.equal(row.tracePast2MiB, true, 'a long real task must retain its late drag frame');
  assert.deepEqual(row.unknownAppLifecycle, [true, true, true, true, false, false],
    'ordinary statuses stay hidden, terminal releases protection, and known geometry can resume');
  assert.deepEqual(row.panelFrameSelftest, [10, 940, 30, 40]);
  assert.deepEqual(row.endingStatusSelftest, { shown: false, panelID: null, panel: null, turnTargets: 2, hideReason: 'host-exit' });
  const ending = JSON.parse(readFileSync(endingPath));
  assert.equal(ending.shown, false); assert.equal(ending.turnTargets, 2); assert.equal(ending.panelID, null);
  assert.equal(ending.hideReason, 'host-exit'); assert.ok(ending.hostTimeMs > 0);
  assert.deepEqual(row.wideWindows, [{ pid: 42, id: 9, frame: [100, 50, 20, 30], reasons: ['drag'] }]);
  assert.equal(row.hideReasonCounts.call, 2);
  assert.equal(row.maxWindowBoundsDifferencePt, 0.5);
  assert.ok(Array.isArray(row.protectedRects));
});
