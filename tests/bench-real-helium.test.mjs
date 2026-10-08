import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOwned } from '../bench/preapproved-process.mjs';

test('Helium ownership comes from creation events, with no access to existing owner windows', async () => {
  const { heliumHelper } = await import('../bench/real-helium.mjs');
  const command = await heliumHelper();
  const result = await runOwned(command, ['--self-test'], { timeoutMs: 15000 });
  assert.equal(result.groupClean, true);
  assert.equal(result.exit.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { delayedFixture: true, ambiguousCreationRefused: true, existingWindowsRead: 0 });
  const source = readFileSync(new URL('../bench/real-helium.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /kAXWindowsAttribute|kAXFocusedWindowAttribute|NSAppleScript|ScriptingBridge/);
});
