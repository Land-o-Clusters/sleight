import test from 'node:test';
import assert from 'node:assert/strict';
import * as live from '../bench/hand/check4-live.mjs';

test('task spawns preserve ownership and run at nice 20 while leaving the cost launcher unchanged', () => {
  assert.equal(typeof live.check4TaskSpawner, 'function');
  const calls = [], child = { pid: 42 }, options = { cwd: '/fixture', stdio: ['pipe', 'pipe', 'pipe'] };
  const spawn = live.check4TaskSpawner((...args) => { calls.push(args); return child; });
  assert.equal(spawn('/node', ['/fixture/bench/run.mjs', '--tasks', 'calculator-click'], options), child);
  assert.equal(spawn('/fixture/sampler', ['--status', '/fixture/status'], options), child);
  assert.deepEqual(calls, [
    ['/usr/bin/nice', ['-n', '20', '/node', '/fixture/bench/run.mjs', '--tasks', 'calculator-click'], options],
    ['/usr/bin/nice', ['-n', '20', '/fixture/sampler', '--status', '/fixture/status'], options],
  ]);
});
