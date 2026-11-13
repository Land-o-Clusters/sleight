import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerTemp } from '../scripts/temp-leftovers.mjs';
import { loadCheck4Bench, delegatedCheck4Lock, check4BenchDescriptor, writeCheck4BenchResult } from '../bench/hand/check4-bench.mjs';

const options = { suite: 'world', arm: 'sleight', task: 'calculator-click', runs: 1, auth: 'login', ownerAway: true };
function fixture(t) {
  // The Mac adapter requires the canonical system temporary bank, independently of TMPDIR.
  const dir = realpathSync(registerTemp(t, mkdtempSync(join(realpathSync('/tmp'), 'sleight-check4-bench-'))));
  const lockPath = join(dir, 'lock'); mkdirSync(lockPath); const { dev, ino } = statSync(lockPath);
  const config = { schema: 'sleight.check4-bench/1', dir, task: 'calculator-click', loginConfig: join(dir, 'benchmark-login'), lock: { ownerPid: 42, dev, ino } };
  for (const key of ['result', 'evidence', 'transcript', 'collections', 'pids', 'status', 'trace', 'armDir']) config[key] = join(dir, key);
  const path = join(dir, 'bench-config.json'); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { dir, path, config, lockPath };
}
test('bench adapter requires the isolated one-task login contract and private config', t => {
  const { path, config } = fixture(t);
  assert.deepEqual(loadCheck4Bench(path, options, 42), config);
  for (const extra of [{ suite: 'default' }, { arm: 'sleight,codex' }, { task: 'word-edit' }, { runs: 2 }, { auth: 'api' },
    { ownerAway: false }, { dryRun: true }]) assert.throws(() => loadCheck4Bench(path, { ...options, ...extra }, 42));
  assert.throws(() => loadCheck4Bench(path, options, 99), /config/);
  chmodSync(path, 0o644); assert.throws(() => loadCheck4Bench(path, options, 42), /config/);
});
test('delegated lock retains parent directory and refuses identity changes', async t => {
  const { config, lockPath } = fixture(t);
  const release = delegatedCheck4Lock(config, lockPath); await release();
  assert.equal(statSync(lockPath).ino, config.lock.ino);
  assert.throws(() => delegatedCheck4Lock({ ...config, lock: { ...config.lock, ino: -1 } }, lockPath), /changed/);
});
test('the sleight descriptor targets the private server and results persist unsanitized run timestamps', t => {
  const { dir, config } = fixture(t);
  const spec = check4BenchDescriptor(config, dir, 'node');
  assert.deepEqual(spec.args, [join(dir, 'bench/hand/check4-server.mjs'), join(dir, 'bench-config.json')]);
  assert.equal(spec.env.SLEIGHT_HAND, '1'); assert.equal(spec.env.SLEIGHT_RUNTIME, 'engine');
  const row = { passed: false, stamps: { exitAt: 1234 }, fixtureDir: join(dir, 'fixture') };
  writeCheck4BenchResult(config, { row, cleanupConfirmed: true });
  const stored = JSON.parse(readFileSync(config.result));
  assert.deepEqual(stored.row, row); assert.equal(stored.cleanupConfirmed, true);
  assert.equal(statSync(config.result).mode & 0o777, 0o600);
});
