import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';
import { macCommandSkip } from './requirements.mjs';

test('demo fixture compiles and exercises only arithmetic and stdin validation without windows', { skip: macCommandSkip('xcrun') }, t => {
  const dir = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-dm1-native-'))), binary = join(dir, 'fixture');
  const built = spawnSync('/usr/bin/xcrun', ['swiftc', '-module-cache-path', swiftModuleCache(), 'bench/demo/fixture.swift', '-o', binary], { encoding: 'utf8', timeout: 240000 });
  assert.equal(built.status, 0, built.stderr);
  const run = input => spawnSync(binary, ['--selftest'], { input: JSON.stringify(input), encoding: 'utf8', timeout: 5000 });
  const good = run({ op: 'click', index: 0 });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), { windowsCreated: 0, valid: true, clicks: 1, drags: 1, destination: [440, 120] });
  for (const row of [{ op: 'click', index: 20 }, { op: 'drag', to: [9999, 0] }, { op: 'open', app: 'TextEdit' }, { op: 'click', index: 0, pid: 1 }]) assert.equal(run(row).status, 65);
  const refusal = spawnSync(binary, ['--serve'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(refusal.status, 64);
});
