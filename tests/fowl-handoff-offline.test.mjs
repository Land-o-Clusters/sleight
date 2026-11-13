import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('offline handoff fixtures cannot invoke live app control when presence changes', t => {
  const guard = fileURLToPath(new URL('./fixtures/handoff-app-guard.mjs', import.meta.url));
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const recordsDir = mkdtempSync(join(tmpdir(), 'cs3-app-guard-'));
  t.after(() => rmSync(recordsDir, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  env.SLEIGHT_GUARD_RECORDS = recordsDir;
  const child = spawnSync(process.execPath, ['--import', guard, '--test', '--test-concurrency=2', 'tests/fowl-handoff-runner.test.mjs'],
    { cwd, env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  writeFileSync(join(recordsDir, 'handoff-guarded.log'), child.stdout + child.stderr);
  const records = readdirSync(recordsDir).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')));
  assert.ok(records.length, child.stdout);
  const controls = records.flatMap(record => record.controls);
  assert.deepEqual(controls, [], JSON.stringify({ controls, records }));
  assert.equal(records.reduce((count, record) => count + record.queries, 0), 0, 'offline fixtures must not probe host apps');
});
