import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macCommandSkip } from './requirements.mjs';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { swiftModuleCache } from '../bench/swift-cache.mjs';

test('hover fixture refuses other apps, unknown operations and unnamed Chess windows before access',
  { skip: macCommandSkip('swiftc') }, t => {
    const directory = registerTemp(t, mkdtempSync(join(tmpdir(), 'sleight-hover-fixture-')));
    const binary = join(directory, 'hover-window-fixture');
    const build = spawnSync('/usr/bin/swiftc', ['-module-cache-path', swiftModuleCache(),
      'bench/hover-window-fixture.swift', '-o', binary], { encoding: 'utf8', timeout: 180000 });
    assert.equal(build.status, 0, build.stderr);
    for (const request of [{ app: 'Mail', op: 'prepare' }, { app: 'TextEdit', op: 'prepare' },
      { app: 'Calculator', op: 'unknown' }, { app: 'Chess', op: 'prepare' }]) {
      const run = spawnSync(binary, [JSON.stringify(request)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.ok, false);
      assert.match(result.error, /invalid fixture request|exact window title/);
      assert.equal(result.checkpoint, undefined);
      assert.equal(result.position, undefined);
    }
  });
