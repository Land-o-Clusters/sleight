import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processStartTime, sameProcessStart } from '../plugins/sleight/lib/routine-lock.mjs';

// With `ps -axo … -p`, macOS printed every process, so a live owner never matched its own start.
test('a process start time is one line for that process, and matches itself', () => {
  const start = processStartTime(process.pid);
  assert.ok(start, 'this process has a start time');
  assert.equal(start.split('\n').length, 1);
  assert.ok(Number.isFinite(Date.parse(start)));
  assert.equal(sameProcessStart(start, processStartTime(process.pid)), true);
  assert.equal(processStartTime(2 ** 30), undefined);
});
