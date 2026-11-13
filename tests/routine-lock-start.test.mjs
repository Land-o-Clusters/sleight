import { assertChildStatus } from './fixtures/child-status.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { processStartTime, sameProcessStart } from '../plugins/sleight/lib/routine-lock.mjs';

// With `ps -axo … -p`, macOS printed every process, so a live owner never matched its own start.
test('a process start time is one line for that process, and matches itself', () => {
  const start = processStartTime(process.pid);
  assert.ok(start, 'this process has a start time');
  assert.match(start, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(start.split('\n').length, 1);
  assert.ok(Number.isFinite(Date.parse(start)));
  assert.equal(sameProcessStart(start, processStartTime(process.pid)), true);
  assert.equal(processStartTime(2 ** 30), undefined);
});

test('process start instants stay the same across reader time zones', () => {
  const worker = `import { processStartTime } from ${JSON.stringify(new URL('../plugins/sleight/lib/routine-lock.mjs', import.meta.url).href)};
    console.log(processStartTime(Number(process.argv[1])));`;
  const starts = ['UTC0', 'Pacific/Honolulu', 'Asia/Tokyo'].map(TZ => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', worker, String(process.pid)], {
      env: { ...process.env, TZ }, encoding: 'utf8', timeout: 10000,
     killSignal: 'SIGKILL' });
    assertChildStatus(result, 0, result.stderr);
    const start = result.stdout.trim();
    assert.ok(Math.abs(Date.parse(start) - (Date.now() - process.uptime() * 1000)) < 2000, start);
    return start;
  });
  assert.equal(new Set(starts).size, 1);
});

test('process start identity stays ISO UTC across caller time zones and locales', () => {
  const expected = processStartTime(process.pid);
  const code = `import { processStartTime } from ${JSON.stringify(new URL('../plugins/sleight/lib/routine-lock.mjs', import.meta.url).href)}; console.log(processStartTime(${process.pid}));`;
  for (const TZ of ['Pacific/Honolulu', 'Asia/Tokyo']) {
    const start = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, TZ, LC_ALL: 'C' }, encoding: 'utf8', timeout: 10000,
     killSignal: 'SIGKILL' }).trim();
    assert.equal(start, expected, TZ);
  }
});
