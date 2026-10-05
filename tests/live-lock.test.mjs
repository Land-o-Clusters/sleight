import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';

test('live wrapper waits for owned child cleanup before removing its lock on interruption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-lock-test-'));
  const lock = join(dir, 'live.lock');
  const source = readFileSync(new URL('../bench/drag-polish-live.sh', import.meta.url), 'utf8');
  const script = source.replaceAll('/tmp/sleight-live.lock', lock);
  assert.ok(!script.includes('/tmp/sleight-live.lock'), 'unit test must never use the shared live lock');
  writeFileSync(join(dir, 'run.sh'), script);
  writeFileSync(join(dir, 'node'), `#!/bin/sh
trap 'sleep 0.2; test -d "${lock}" && touch "${dir}/cleaned"; exit 0' TERM
touch "${dir}/ready"
while :; do sleep 0.1; done
`, { mode: 0o755 });
  const child = spawn('/bin/sh', [join(dir, 'run.sh')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    for (let n = 0; n < 100 && !existsSync(join(dir, 'ready')); n++) await wait(20);
    assert.ok(existsSync(join(dir, 'ready')));
    child.kill('SIGTERM');
    assert.deepEqual(await closed, { code: 143, signal: null });
    assert.ok(existsSync(join(dir, 'cleaned')), 'child cleaned up while the lock still existed');
    assert.equal(existsSync(lock), false);
  } finally {
    if (child.exitCode === null) { child.kill('SIGTERM'); await closed; }
    await wait(300);
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a Chess cleanup failure keeps its lock and returns the remaining-window failure code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sleight-lock-test-'));
  const lock = join(dir, 'live.lock');
  const source = readFileSync(new URL('../bench/drag-polish-live.sh', import.meta.url), 'utf8');
  writeFileSync(join(dir, 'run.sh'), source.replaceAll('/tmp/sleight-live.lock', lock));
  writeFileSync(join(dir, 'node'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
  const child = spawn('/bin/sh', [join(dir, 'run.sh'), '--chess'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: 'ignore' });
  try {
    const code = await new Promise(resolve => child.once('close', resolve));
    assert.equal(code, 73); assert.equal(existsSync(lock), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
