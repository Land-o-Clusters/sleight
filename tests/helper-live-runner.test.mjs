import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('live runner waits for cancelled child cleanup before releasing its lock', { timeout: 5000 }, async t => {
  const bank = await mkdtemp(join(tmpdir(), 'sleight-lock-test-'));
  t.after(() => rm(bank, { recursive: true, force: true }));
  const bin = join(bank, 'bin'); await mkdir(bin);
  const log = join(bank, 'events');
  await writeFile(join(bin, 'mkdir'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, 'rmdir'), '#!/bin/sh\necho released >> "$SLEIGHT_TEST_LOG"\n', { mode: 0o755 });
  await writeFile(join(bin, 'node'), '#!/bin/sh\necho "started $$" >> "$SLEIGHT_TEST_LOG"\ntrap \'echo cancelled >> "$SLEIGHT_TEST_LOG"; /bin/sleep 0.2; echo cleaned >> "$SLEIGHT_TEST_LOG"; exit 0\' TERM\nwhile :; do /bin/sleep 0.05; done\n', { mode: 0o755 });
  const runner = fileURLToPath(new URL('../scripts/live-helper-check.sh', import.meta.url));
  const child = spawn('/bin/sh', [runner, 'smoke'], { env: { ...process.env, PATH: bin, SLEIGHT_TEST_LOG: log } });
  const closed = new Promise(resolve => child.once('close', resolve));
  let events = '';
  for (let n = 0; n < 100; n++) {
    try { events = await readFile(log, 'utf8'); if (events.includes('started')) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const fixturePid = Number(events.match(/started (\d+)/)?.[1]);
  assert.ok(fixturePid);
  t.after(() => { try { process.kill(fixturePid, 'SIGTERM'); } catch {} });
  child.kill('SIGTERM');
  const code = await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve('not collected'), 1500))]);
  events = await readFile(log, 'utf8');
  assert.equal(code, 143);
  assert.match(events, /cancelled\ncleaned\nreleased\n$/);
});
