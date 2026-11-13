import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { probe, probes } from './fixtures/sa1h-probe.mjs';

for (const name of probes) test(`SA1H invariant and broken variant: ${name}`, async t => {
  await probe(name);
  const config = registerTemp(t, realpathSync(mkdtempSync(join(tmpdir(), 'lane-claude-'))));
  const child = spawnSync('/usr/bin/nice', ['-n', '20', process.execPath, new URL('./fixtures/sa1h-probe.mjs', import.meta.url).pathname, name],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, null);
  assert.equal(child.status, 1, child.stderr.slice(-1500));
  assert.match(child.stderr, /AssertionError/);
  assert.doesNotMatch(child.stderr, /mutation site:/);
  t.diagnostic(`${name}: unchanged exit 0; broken variant exit ${child.status}, assertion failed`);
});
