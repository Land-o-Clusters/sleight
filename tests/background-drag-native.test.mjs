import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('native prototype compiles and validates diagnostic requests without app access', { skip: process.platform !== 'darwin' }, t => {
  const bank = mkdtempSync('/private/tmp/sleight-drag-native-test-');
  t.after(() => rmSync(bank, { recursive: true, force: true }));
  const executable = join(bank, 'drag');
  const build = spawnSync('/usr/bin/swiftc', ['-O', '-module-cache-path', join(bank, 'cache'), '-o', executable,
    'bench/background-drag/background-drag.swift'], { encoding: 'utf8', timeout: 180000 });
  assert.equal(build.status, 0, build.stderr);
  const input = { app: 'TextEdit', from: [20, 40], to: [200, 40], posting: 'psn', command: false, select: true, holdMs: 2000 };
  const validated = JSON.parse(execFileSync(executable, ['--validate-only', JSON.stringify(input)], { encoding: 'utf8' }));
  assert.deepEqual(validated, { ok: true, posting: 'psn', command: false, select: true, holdMs: 2000 });
  for (const change of [{ holdMs: 5001 }, { posting: 'hid' }, { from: [2] }, { steps: 0 }, { mode: 'hid' }]) {
    const refusal = spawnSync(executable, ['--validate-only', JSON.stringify({ ...input, ...change })], { encoding: 'utf8' });
    assert.equal(refusal.status, 1);
    assert.equal(JSON.parse(refusal.stdout).ok, false);
  }
});
