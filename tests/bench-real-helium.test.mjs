import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOwned } from '../bench/preapproved-process.mjs';

test('Helium acquires creation events and recovers only a retained window reference', async () => {
  const { heliumHelper } = await import('../bench/real-helium.mjs');
  const command = await heliumHelper();
  const result = await runOwned(command, ['--self-test'], { timeoutMs: 15000 });
  assert.equal(result.groupClean, true);
  assert.equal(result.exit.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { delayedFixture: true, ambiguousCreationRefused: true, existingWindowsRead: 0, retainedRecovery: true, unmatchedCreationUnowned: true, retainedNavigation: true, profileCommands: true, preActionBlankRefused: true, postCommandBlankRefused: true });
  const source = readFileSync(new URL('../bench/real-helium.swift', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /kAXWindowsAttribute|kAXFocusedWindowAttribute|NSAppleScript|ScriptingBridge/);
  const acquisition = source.slice(source.indexOf('func fixture('), source.indexOf('    } catch {\n        if setup'));
  assert.doesNotMatch(acquisition, /kAXWindowsAttribute|recoverSetup\(/);
});
