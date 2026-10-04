import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('hover fixture refuses other apps, unknown operations and unnamed Chess windows before access',
  { skip: process.platform !== 'darwin' }, () => {
    const build = spawnSync(process.execPath, ['bench/hover-build.mjs'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    for (const request of [{ app: 'Mail', op: 'prepare' }, { app: 'TextEdit', op: 'prepare' },
      { app: 'Calculator', op: 'unknown' }, { app: 'Chess', op: 'prepare' }]) {
      const run = spawnSync('bench/results/hover-window-fixture', [JSON.stringify(request)], { encoding: 'utf8', timeout: 5000 });
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.ok, false);
      assert.match(result.error, /invalid fixture request|exact window title/);
      assert.equal(result.checkpoint, undefined);
      assert.equal(result.position, undefined);
    }
  });
