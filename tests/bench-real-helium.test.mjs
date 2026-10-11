import test from './macos-only.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOwned } from '../bench/preapproved-process.mjs';

for (const scenario of ['fixture-navigation', 'safari-address', 'safari-recovery', 'control-command', 'timeout-recovery', 'shop-smoke',
  'window-cleanup-tab', 'window-cleanup-sheet', 'window-cleanup-dialog', 'window-cleanup-refused',
  'window-cleanup-still-listed', 'window-cleanup-second', 'window-cleanup-system',
  'window-cleanup-cancel-refused', 'window-cleanup-dialog-changed', 'window-cleanup-late-sheet',
  'window-cleanup-late-second']) {
  test(`browser regression: ${scenario}`, async () => {
    const { heliumHelper } = await import('../bench/real-helium.mjs');
    const command = await heliumHelper();
    const result = await runOwned(command, ['--self-test', scenario], { timeoutMs: 15000 });
    assert.equal(result.groupClean, true);
    assert.equal(result.exit.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { scenario, passed: true });
  });
}

test('Helium acquires creation events and recovers only a retained window reference', async () => {
  const { heliumHelper } = await import('../bench/real-helium.mjs');
  const command = await heliumHelper();
  const result = await runOwned(command, ['--self-test'], { timeoutMs: 15000 });
  assert.equal(result.groupClean, true);
  assert.equal(result.exit.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { delayedFixture: true, ambiguousCreationRefused: true, existingWindowsRead: 0, retainedRecovery: true, unmatchedCreationUnowned: true, retainedNavigation: true, profileCommands: true, preActionBlankRefused: true, postCommandBlankRefused: true });
  const source = readFileSync(new URL('../bench/real-helium.swift', import.meta.url), 'utf8');
  assert.match(source, /Shop smoke fixtures require retained-url setup/);
  assert.doesNotMatch(source, /NSAppleScript|ScriptingBridge/);
  const acquisition = source.slice(source.indexOf('func fixture('), source.indexOf('    setup = false'));
  assert.doesNotMatch(acquisition, /kAXWindowsAttribute|recoverSetup\(/);
});
