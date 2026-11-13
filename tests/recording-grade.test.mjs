import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pillow } from './fixtures/recording-grade.mjs';

const skip = spawnSync('python3', ['--version'], { timeout: 10000, killSignal: 'SIGKILL' }).status === 0 ? false : 'python3 required';

test('the Pillow helper passes multi-megabyte input through a file, not stdin', { skip }, () => {
  const input = Buffer.alloc(1920 * 1080 * 4, 7);
  const { stdout, output } = pillow(`import sys
raw=open(sys.argv[1],'rb').read(); print(len(raw), sys.stdin.read() == '')
open(sys.argv[2],'wb').write(raw[:3])`, input);
  assert.equal(stdout.trim(), `${input.length} True`);
  assert.deepEqual([...output], [7, 7, 7]);
});

test('a stalled Pillow child fails within its bound instead of holding the test file', { skip }, () => {
  const started = Date.now();
  assert.throws(() => pillow('import time\ntime.sleep(60)', Buffer.alloc(1), [], 500), /ETIMEDOUT/);
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
});
