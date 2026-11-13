import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { behaviorNames, brokenVariants, runBehavior } from './fixtures/windows-confinement-behavior.mjs';
import { assertChildStatus } from './fixtures/child-status.mjs';

for (const name of behaviorNames) test('UC3H3 production parent: ' + name, () => runBehavior(name));
for (const variant of brokenVariants) test('UC3H3 broken parent variant exits 1: ' + variant, () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/windows-confinement-behavior.mjs', import.meta.url)), variant],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assertChildStatus(child, 1, child.stdout + child.stderr);
  assert.match(child.stderr, /Expected|Missing expected|strictly equal/);
});
