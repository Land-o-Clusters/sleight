import { assertChildStatus } from './fixtures/child-status.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('stage native tests skip before compiling on Linux', () => {
  const preload = 'data:text/javascript,' + encodeURIComponent("Object.defineProperty(process, 'platform', { value: 'linux' });");
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['--import', preload, '--test', '--test-reporter=tap',
    new URL('./hand-stage.test.mjs', import.meta.url).pathname],
  { encoding: 'utf8', timeout: 300000, env, killSignal: 'SIGKILL' });
  assertChildStatus(r, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /# pass 0\b/);
  assert.match(r.stdout, /# SKIP xcrun requires macOS/);
  assert.match(r.stdout, /xcrun requires macOS/);
});
